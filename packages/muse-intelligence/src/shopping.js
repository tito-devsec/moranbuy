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
customerName (their name only if they state it, else null), confidence (0 to 1). Budget words: "laki" = 100,000; "elfu" = 1,000; "milioni" = 1,000,000; "k" = 1,000.
When a full number follows the word, the number is the amount: "laki 350000" = 350000, "elfu 90000" = 90000. A budget above 1,000,000,000 is a mistake: give null.
Sizes go in essentialAttributes in gigabytes as numbers; "kuanzia", "angalau", "at least" make a minimum: "Rami kuanzia 8" -> "ram": {"min": 8}; "SSD kuanzia 128" -> "storage": {"min": 128}; "8GB RAM" -> "ram": 8.
A named brand is essential: "kampuni iwe hp" -> "brand": "hp". Keep productType to the product itself ("laptop", "smartphone"), never a place, a question or a brand.
If the customer is answering a question MoranBuy asked, fill only what the answer gives: an answer to "where are you" is locationText ("mbagala dar" -> "Mbagala, Dar es Salaam") and productType stays null.
Example: "Me nahitaji laptop Nina laki 350000, iwe na Rami kuanzia 8 and storage SSD kuanzia 128 kampuni iwe hp" -> {"productType":"laptop","category":"electronics","essentialAttributes":{"ram":{"min":8},"storage":{"min":128},"brand":"hp"},"maxBudget":350000,"currency":"TZS","intent":"shop","language":"sw"}.
Answer with the JSON object only, no words before or after it.`;

export async function museExtractRequest(muse, { text, imageUrl = null, imageDataUrl = null, context = {} }) {
  const content = [];
  if (text) content.push({ type: 'text', text });
  if (imageUrl || imageDataUrl) content.push({ type: 'image_url', image_url: { url: imageDataUrl || imageUrl } });
  if (!content.length) return { ok: false, status: 'empty' };
  const messages = [];
  if (context.previousRequest) messages.push({ role: 'user', content: `Current request so far (JSON): ${JSON.stringify(context.previousRequest)}` });
  if (context.presentedOffers) messages.push({ role: 'user', content: `Options already shown, numbered: ${JSON.stringify(context.presentedOffers)}` });
  if (context.answering) messages.push({ role: 'user', content: `The next message answers MoranBuy's question about: ${context.answering}` });
  messages.push({ role: 'user', content });
  return muse.complete({ feature: imageUrl || imageDataUrl ? 'image' : 'intent', system: SYSTEM, messages, maxTokens: 2500, reasoningEffort: 'minimal', requestRef: context.requestRef || null });
}
