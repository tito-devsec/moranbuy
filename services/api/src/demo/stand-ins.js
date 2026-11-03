import { FakeMoranInternalClient, FakeGeocoder } from '@moranbuy/integrations';

// The demo's WhatsApp: every message MoranBuy would send is kept in memory with its time, so the demo phone can show it.
// Messages to businesses and riders are written in Swahili with the English under a "/" line; the demo, made for an English-reading audience, keeps the English.
const TITLES = { Nakubali: 'I accept', Sikubali: 'I decline', Imekataliwa: 'Refused', 'Mteja hayupo': 'Customer not there', 'Ndio, nimekataa': 'Yes, I refused', Hapana: 'No' };
export function englishOnly(m) {
  if (process.env.DEMO_LANGUAGE === 'sw') return m;
  const out = { ...m };
  const en = (s) => { const parts = String(s).split(/\n\/ /); return parts.length === 2 ? parts[1] : s; };
  if (typeof out.body === 'string') out.body = en(out.body);
  if (typeof out.caption === 'string') out.caption = en(out.caption);
  if (Array.isArray(out.buttons)) out.buttons = out.buttons.map((b) => ({ ...b, title: b.title.includes(' / ') ? b.title.split(' / ').pop() : TITLES[b.title] || b.title }));
  return out;
}

export class RecordingMoranClient extends FakeMoranInternalClient {
  constructor() { super(); this.log = []; }
  record(raw) {
    const m = englishOnly(raw);
    this.log.push({ seq: this.log.length + 1, at: new Date().toISOString(), ...m });
    if (this.log.length > 20000) this.log.splice(0, 5000);
  }
  async sendText(m) { this.record({ type: 'text', ...m }); return super.sendText(m); }
  async sendImage(m) { this.record({ type: 'image', ...m }); return super.sendImage(m); }
  async sendButtons(m) { this.record({ type: 'buttons', ...m }); return super.sendButtons(m); }
  async sendAudio(m) { this.record({ type: 'audio', ...m }); return super.sendAudio(m); }
  async sendDocument(m) { this.record({ type: 'document', ...m }); return super.sendDocument(m); }
  async sendList(m) { this.record({ type: 'list', ...m }); return super.sendList(m); }
  async sendMoranBuyTemplate(m) { this.record({ type: 'template', ...m }); return super.sendMoranBuyTemplate(m); }
  // Only what went to these numbers after a sequence number; the bytes of documents and audio stay on the server.
  since(phones, after = 0) {
    const set = new Set(phones);
    return this.log.filter((m) => m.seq > after && set.has(m.to));
  }
}

// Places around Dar es Salaam the demo understands, without calling an outside map service.
export const DEMO_PLACES = Object.freeze({
  'sinza mori': { lat: -6.7745, lng: 39.2235, label: 'Sinza Mori, Dar es Salaam' },
  sinza: { lat: -6.776, lng: 39.23, label: 'Sinza, Dar es Salaam' },
  mwenge: { lat: -6.7676, lng: 39.2245, label: 'Mwenge, Dar es Salaam' },
  kijitonyama: { lat: -6.7748, lng: 39.2419, label: 'Kijitonyama, Dar es Salaam' },
  kariakoo: { lat: -6.8193, lng: 39.2737, label: 'Kariakoo, Dar es Salaam' },
  ubungo: { lat: -6.7894, lng: 39.2069, label: 'Ubungo, Dar es Salaam' },
  mikocheni: { lat: -6.7614, lng: 39.2526, label: 'Mikocheni, Dar es Salaam' },
  masaki: { lat: -6.7486, lng: 39.2824, label: 'Masaki, Dar es Salaam' },
  kinondoni: { lat: -6.7754, lng: 39.2502, label: 'Kinondoni, Dar es Salaam' },
  mbezi: { lat: -6.7214, lng: 39.1717, label: 'Mbezi, Dar es Salaam' },
});

export const demoGeocoder = () => new FakeGeocoder(DEMO_PLACES);

let recording = null;
export const demoMoran = () => (recording ||= new RecordingMoranClient());
