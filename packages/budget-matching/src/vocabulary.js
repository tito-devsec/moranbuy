// Product words customers and businesses use, in Swahili and English, mapped to one English product type and category so statistics add up per product.
const VOCAB = [
  ['sofa', 'furniture', ['sofa', 'kochi', 'makochi', 'couch', 'sofa set', 'seti ya sofa']],
  ['bed', 'furniture', ['kitanda', 'vitanda', 'bed', 'beds']],
  ['mattress', 'furniture', ['godoro', 'magodoro', 'mattress']],
  ['table', 'furniture', ['meza', 'table', 'dining table', 'meza ya kulia']],
  ['chair', 'furniture', ['kiti', 'viti', 'chair', 'chairs']],
  ['wardrobe', 'furniture', ['kabati la nguo', 'kabati', 'wardrobe', 'closet']],
  ['smartphone', 'phones', ['simu', 'smartphone', 'phone', 'iphone', 'samsung', 'tecno', 'infinix', 'itel', 'redmi', 'xiaomi', 'oppo']],
  ['television', 'electronics', ['tv', 'television', 'televisheni', 'runinga', 'smart tv']],
  ['fridge', 'electronics', ['jokofu', 'friji', 'fridge', 'refrigerator', 'freezer']],
  ['laptop', 'electronics', ['laptop', 'kompyuta', 'computer', 'pc', 'macbook']],
  ['speaker', 'electronics', ['spika', 'speaker', 'woofer', 'subwoofer', 'soundbar']],
  ['cooker', 'home', ['jiko', 'majiko', 'cooker', 'gas cooker', 'stove', 'oven']],
  ['blender', 'home', ['blender', 'blenda']],
  ['washing machine', 'home', ['mashine ya kufua', 'washing machine']],
  ['fan', 'home', ['feni', 'fan']],
  ['air conditioner', 'home', ['ac', 'air conditioner', 'kiyoyozi']],
  ['shoes', 'fashion', ['viatu', 'shoes', 'sneakers', 'raba', 'sandals']],
  ['dress', 'fashion', ['gauni', 'magauni', 'dress', 'dera', 'vitenge', 'kitenge']],
  ['clothing', 'fashion', ['nguo', 'clothes', 'shirt', 'shati', 'suruali', 'trousers', 'jeans']],
  ['bag', 'fashion', ['mkoba', 'mikoba', 'bag', 'handbag', 'begi']],
  ['watch', 'fashion', ['saa', 'watch']],
  ['perfume', 'beauty', ['marashi', 'perfume', 'manukato']],
  ['wig', 'beauty', ['wigi', 'wig', 'nywele', 'hair']],
  ['rice', 'food', ['mchele', 'rice']],
  ['cooking oil', 'food', ['mafuta ya kupikia', 'cooking oil']],
  ['motorcycle', 'vehicles', ['pikipiki', 'bodaboda', 'boda', 'motorcycle', 'motorbike']],
  ['car', 'vehicles', ['gari', 'magari', 'car', 'toyota', 'suzuki', 'nissan']],
  ['bicycle', 'vehicles', ['baiskeli', 'bicycle', 'bike']],
  ['cement', 'building', ['saruji', 'cement', 'simenti']],
  ['iron sheets', 'building', ['bati', 'mabati', 'iron sheets', 'roofing sheets']],
  ['tiles', 'building', ['tiles', 'vigae', 'marumaru']],
  ['paint', 'building', ['rangi', 'paint']],
  ['solar panel', 'electronics', ['solar', 'sola', 'solar panel', 'paneli']],
  ['generator', 'electronics', ['jenereta', 'generator']],
  ['water pump', 'building', ['pampu', 'pump', 'water pump']],
];
const ENTRIES = VOCAB.flatMap(([type, category, words]) => words.map((w) => ({ w, type, category }))).sort((a, b) => b.w.length - a.w.length);

// The canonical product type and category for a phrase, or null fields when no known word is in it.
export function normalizeProductType(text) {
  const t = ` ${String(text || '').toLowerCase().replace(/[^a-z0-9' ]+/g, ' ').replace(/\s+/g, ' ').trim()} `;
  for (const e of ENTRIES) if (t.includes(` ${e.w} `)) return { productType: e.type, category: e.category, matched: e.w };
  return { productType: null, category: null, matched: null };
}
