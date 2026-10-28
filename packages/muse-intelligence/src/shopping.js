// Asks Muse Spark to read a customer's message (and photo) into the structured shopping request fields; the caller validates the answer.
const SYSTEM = `You read shopping requests from customers in Tanzania, written in Swahili, English or a mix.
Extract only what the customer actually said. Never guess a budget, a location or an attribute that is not stated.
Answer with one JSON object with these keys:
productType (short noun in English, e.g. "sofa", "smartphone"), category (one of: furniture, electronics, phones, fashion, home, beauty, food, vehicles, building, other),
essentialAttributes (object of attributes the customer requires, e.g. {"seats": 3, "color": "grey"}), preferredAttributes (object of nice-to-haves),
maxBudget (integer in the currency, or null), currency ("TZS" unless stated otherwise), quantity (integer, default 1),
locationText (the place the customer named, or null), fulfilment ("delivery", "pickup" or "any"),
alternativesOk (true when the customer accepts alternatives), urgency (text or null), language ("sw" or "en"),
intent ("shop", "clarify", "select", "confirm", "cancel", "other"), selection (integer option number when the customer picks an offer, else null),
purchaseTiming ("now" when they want to buy now, "later" when they name a later time or say they will come back, "browsing" when only looking, else null),
schedule (when the customer asks to be contacted later or names when they will buy: {"when": "their words for the time", "note": "what to do then"}, else null),
customerName (their name only if they state it, else null), confidence (0 to 1). Budget words: "laki" = 100,000; "elfu" = 1,000; "milioni" = 1,000,000; "k" = 1,000.`;

export async function museExtractRequest(muse, { text, imageUrl = null, imageDataUrl = null, context = {} }) {
  const content = [];
  if (text) content.push({ type: 'text', text });
  if (imageUrl || imageDataUrl) content.push({ type: 'image_url', image_url: { url: imageDataUrl || imageUrl } });
  if (!content.length) return { ok: false, status: 'empty' };
  const messages = [];
  if (context.previousRequest) messages.push({ role: 'user', content: `Current request so far (JSON): ${JSON.stringify(context.previousRequest)}` });
  if (context.presentedOffers) messages.push({ role: 'user', content: `Options already shown, numbered: ${JSON.stringify(context.presentedOffers)}` });
  messages.push({ role: 'user', content });
  return muse.complete({ feature: imageUrl || imageDataUrl ? 'image' : 'intent', system: SYSTEM, messages, maxTokens: 600, requestRef: context.requestRef || null });
}
