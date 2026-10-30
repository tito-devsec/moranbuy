// Decides which essential detail is still missing and phrases one short question for it, without repeating what is known.
export function missingEssentials(request) {
  const missing = [];
  if (!request.productType) missing.push('productType');
  if (!request.maxBudget) missing.push('maxBudget');
  if (!request.location && !request.locationText) missing.push('location');
  return missing;
}

const QUESTIONS = {
  sw: {
    productType: 'Unatafuta bidhaa gani hasa? Taja aina na sifa muhimu (mfano: sofa ya watu watatu, rangi).',
    maxBudget: 'Bajeti yako ya juu ni shilingi ngapi?',
    location: 'Upo wapi? Taja mtaa na mji (mfano: Sinza, Dar es Salaam) au tuma location yako.',
  },
  en: {
    productType: 'What exactly are you looking for? Name the product and the must-have details.',
    maxBudget: 'What is the most you can spend?',
    location: 'Where are you? Name the area and city, or share your location.',
  },
};

export function clarificationQuestion(request, { skip = [] } = {}) {
  const missing = missingEssentials(request).filter((f) => !skip.includes(f));
  if (!missing.length) return null;
  const lang = request.language === 'en' ? 'en' : 'sw';
  return { field: missing[0], question: QUESTIONS[lang][missing[0]] };
}
