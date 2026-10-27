import { config } from '@moranbuy/core';
import { MoranOwnerClient, Geocoder } from '@moranbuy/integrations';

let shared = null;

// Clients the merchant routes use: Moran's owner API and the geocoder; tests inject fakes.
export function merchantDeps() {
  if (!shared) {
    const c = config();
    shared = { moran: new MoranOwnerClient({ cfg: c }), geocoder: new Geocoder({ cfg: c }) };
  }
  return shared;
}

export function setMerchantDepsForTests(deps) { shared = deps; }
