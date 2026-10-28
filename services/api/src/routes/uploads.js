import express from 'express';
import { z } from 'zod';
import { ApiError, notFound } from '@moranbuy/core';
import { requireMerchantAuth } from '@moranbuy/authorization';
import { asyncHandler } from '../middleware/async-handler.js';
import { validate } from '../middleware/validate.js';
import { db } from '../db/connection.js';
import { saveUpload, readUpload, publicUpload, deleteUpload } from '../services/uploads.js';

// The raw file is the request body; its declared type only lets it through, its bytes decide what it is.
export const rawFile = express.raw({ type: ['image/jpeg', 'image/png', 'image/webp', 'application/pdf', 'audio/wav', 'audio/x-wav', 'audio/wave', 'audio/ogg', 'application/octet-stream'], limit: '17mb' });

export const merchantUploadsRouter = express.Router();
merchantUploadsRouter.use(requireMerchantAuth(db));

merchantUploadsRouter.post('/', rawFile, validate({ query: z.object({ purpose: z.enum(['product_image', 'verification_document']), name: z.string().max(160).optional() }).passthrough() }), asyncHandler(async (req, res) => {
  const row = await saveUpload({ buffer: req.body, purpose: req.query.purpose, merchantId: req.merchant.id, originalName: req.query.name || null, uploadedBy: req.merchantUser.id });
  res.status(201).json({ upload: publicUpload(row) });
}));
merchantUploadsRouter.get('/', asyncHandler(async (req, res) => res.json({ uploads: (await db('uploads').where({ merchant_id: req.merchant.id }).orderBy('created_at', 'desc').limit(200)).map(publicUpload) })));
// A business reads its own files, private ones included.
merchantUploadsRouter.get('/:id/file', validate({ params: z.object({ id: z.string().uuid() }) }), asyncHandler(async (req, res) => {
  const row = await db('uploads').where({ id: req.params.id, merchant_id: req.merchant.id }).first();
  if (!row) throw notFound('UPLOAD_NOT_FOUND');
  res.set({ 'Content-Type': row.mime, 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Disposition': `inline; filename="${row.storage_key}"` }).send(await readUpload(row));
}));
// A file still used by a listing or a pending verification is not deleted.
merchantUploadsRouter.delete('/:id', validate({ params: z.object({ id: z.string().uuid() }) }), asyncHandler(async (req, res) => {
  const row = await db('uploads').where({ id: req.params.id, merchant_id: req.merchant.id }).first();
  if (!row) throw notFound('UPLOAD_NOT_FOUND');
  const inListing = await db('listings').where({ merchant_id: req.merchant.id }).whereNull('deleted_at').where('image_url', 'like', `%/media/${row.storage_key}`).first('id');
  const inVerification = req.merchant.verification_status === 'pending' && JSON.stringify(req.merchant.verification_json || {}).includes(row.id);
  if (inListing || inVerification) throw new ApiError(409, 'UPLOAD_IN_USE', inListing ? 'A product still shows this image.' : 'Your pending verification uses this document.');
  await deleteUpload(db, row);
  res.json({ deleted: true });
}));

// Product photos are public by design: they are what customers see.
export const mediaRouter = express.Router();
mediaRouter.get('/:key', asyncHandler(async (req, res) => {
  if (!/^[0-9a-f-]{36}\.(jpg|png|webp)$/.test(req.params.key)) throw notFound('MEDIA_NOT_FOUND');
  const row = await db('uploads').where({ storage_key: req.params.key, purpose: 'product_image' }).first();
  if (!row) throw notFound('MEDIA_NOT_FOUND');
  res.set({ 'Content-Type': row.mime, 'Cache-Control': 'public, max-age=86400', 'X-Content-Type-Options': 'nosniff' }).send(await readUpload(row));
}));
