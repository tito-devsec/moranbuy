// Tanzania's regions and the districts and well-known neighbourhoods customers actually name, so every location lands in a region and district for statistics.
const REGIONS = ['Arusha', 'Dar es Salaam', 'Dodoma', 'Geita', 'Iringa', 'Kagera', 'Katavi', 'Kigoma', 'Kilimanjaro', 'Lindi', 'Manyara', 'Mara', 'Mbeya', 'Morogoro', 'Mtwara', 'Mwanza', 'Njombe', 'Pemba North', 'Pemba South', 'Pwani', 'Rukwa', 'Ruvuma', 'Shinyanga', 'Simiyu', 'Singida', 'Songwe', 'Tabora', 'Tanga', 'Unguja North', 'Unguja South', 'Zanzibar Urban West'];

// District → region, with the neighbourhoods that belong to each district listed under it.
const DISTRICTS = {
  'Dar es Salaam': {
    Kinondoni: ['kinondoni', 'mikocheni', 'msasani', 'masaki', 'oysterbay', 'oyster bay', 'mwananyamala', 'magomeni', 'kawe', 'mbezi beach', 'tegeta', 'kunduchi', 'bunju', 'mwenge', 'namanga', 'sinza', 'makumbusho'],
    Ilala: ['ilala', 'kariakoo', 'posta', 'upanga', 'gerezani', 'buguruni', 'tabata', 'segerea', 'kipawa', 'ukonga', 'kitunda', 'pugu', 'vingunguti', 'kivukoni', 'city centre', 'mchikichini', 'kurasini'],
    Temeke: ['temeke', 'mbagala', 'chang\'ombe', 'changombe', 'kigamboni', 'tandika', 'mtoni', 'kurasini', 'yombo', 'kijichi', 'charambe', 'toangoma'],
    Ubungo: ['ubungo', 'mbezi', 'kimara', 'makuburi', 'manzese', 'mabibo', 'goba', 'saranga', 'kibamba', 'mbezi luis'],
    Kigamboni: ['kigamboni', 'kibada', 'vijibweni', 'tungi', 'mjimwema'],
  },
  Arusha: { 'Arusha City': ['arusha', 'njiro', 'sakina', 'kijenge', 'themi', 'unga limited', 'ngarenaro', 'moshono'], Arumeru: ['usa river', 'tengeru', 'arumeru'] },
  Mwanza: { Nyamagana: ['mwanza', 'nyamagana', 'kirumba', 'pamba', 'mabatini', 'igoma'], Ilemela: ['ilemela', 'nyakato', 'buswelu', 'kiseke'] },
  Dodoma: { 'Dodoma City': ['dodoma', 'area c', 'area d', 'kikuyu', 'nkuhungu', 'chamwino', 'ipagala'] },
  Mbeya: { 'Mbeya City': ['mbeya', 'uyole', 'iyunga', 'sinde', 'forest', 'mwanjelwa'] },
  Kilimanjaro: { Moshi: ['moshi', 'kiboriloni', 'majengo', 'pasua', 'soweto', 'shanty town'], Hai: ['hai', 'bomang\'ombe', 'bomangombe'] },
  Morogoro: { 'Morogoro Municipal': ['morogoro', 'kihonda', 'mazimbu', 'kilakala', 'mwembesongo'] },
  Tanga: { 'Tanga City': ['tanga', 'ngamiani', 'chumbageni', 'makorora'] },
  Zanzibar: { 'Mjini Magharibi': ['zanzibar', 'unguja', 'stone town', 'mjini', 'fuoni', 'kiembe samaki'] },
  Pwani: { Kibaha: ['kibaha', 'mlandizi', 'maili moja', 'tumbi'], Bagamoyo: ['bagamoyo'] },
  Geita: { 'Geita Town': ['geita'] }, Iringa: { 'Iringa Municipal': ['iringa', 'gangilonga', 'mkwawa'] }, Kagera: { Bukoba: ['bukoba', 'kagera'] },
  Kigoma: { 'Kigoma-Ujiji': ['kigoma', 'ujiji'] }, Lindi: { 'Lindi Municipal': ['lindi'] }, Manyara: { Babati: ['babati', 'manyara'] }, Mara: { Musoma: ['musoma', 'mara'] },
  Mtwara: { 'Mtwara Municipal': ['mtwara'] }, Njombe: { 'Njombe Town': ['njombe'] }, Rukwa: { Sumbawanga: ['sumbawanga', 'rukwa'] }, Ruvuma: { Songea: ['songea', 'ruvuma'] },
  Shinyanga: { 'Shinyanga Municipal': ['shinyanga', 'kahama'] }, Simiyu: { Bariadi: ['bariadi', 'simiyu'] }, Singida: { 'Singida Municipal': ['singida'] }, Songwe: { Tunduma: ['tunduma', 'songwe'] },
  Tabora: { 'Tabora Municipal': ['tabora'] }, Katavi: { Mpanda: ['mpanda', 'katavi'] },
};

// A flat lookup from every known word to its region and district, longest names first so "mbezi beach" wins over "mbezi".
const INDEX = [];
for (const [region, districts] of Object.entries(DISTRICTS)) {
  for (const [district, names] of Object.entries(districts)) for (const n of names) INDEX.push({ name: n, region: region === 'Zanzibar' ? 'Zanzibar Urban West' : region, district });
}
for (const r of REGIONS) INDEX.push({ name: r.toLowerCase(), region: r, district: null });
// A district-level name wins over a bare region name, and a longer name over a shorter one.
INDEX.sort((a, b) => (b.district ? 1 : 0) - (a.district ? 1 : 0) || b.name.length - a.name.length);

// Finds the region and district a free-text place belongs to; null fields when the place is unknown.
export function resolvePlace(text) {
  const t = ` ${String(text || '').toLowerCase().replace(/[^a-z' ]+/g, ' ').replace(/\s+/g, ' ').trim()} `;
  if (!t.trim()) return { region: null, district: null, matched: null };
  for (const e of INDEX) if (t.includes(` ${e.name} `)) return { region: e.region, district: e.district, matched: e.name };
  return { region: null, district: null, matched: null };
}

export const TANZANIA_REGIONS = Object.freeze(REGIONS);
