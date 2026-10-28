# Exports Meta's MMS text-to-speech models (facebook/mms-tts-*) to ONNX for MoranBuy's in-process speech; run once per image build.
import json, os, sys
import torch
from onnxruntime.quantization import quantize_dynamic, QuantType
from transformers import VitsModel, VitsTokenizer

out_dir = sys.argv[1] if len(sys.argv) > 1 else 'models/tts'
langs = sys.argv[2].split(',') if len(sys.argv) > 2 else ['swh', 'eng']

class Speak(torch.nn.Module):
    # Wraps VITS so the ONNX graph takes token ids and returns the waveform only.
    def __init__(self, model):
        super().__init__()
        self.model = model
    def forward(self, input_ids):
        return self.model(input_ids=input_ids).waveform

for lang in langs:
    name = f'facebook/mms-tts-{lang}'
    model = VitsModel.from_pretrained(name).eval()
    tok = VitsTokenizer.from_pretrained(name)
    dest = os.path.join(out_dir, lang)
    os.makedirs(dest, exist_ok=True)
    ids = tok('habari yako leo', return_tensors='pt').input_ids
    full = os.path.join(dest, 'model.full.onnx')
    torch.onnx.export(Speak(model), (ids,), full, input_names=['input_ids'], output_names=['waveform'],
                      dynamic_axes={'input_ids': {1: 'tokens'}, 'waveform': {1: 'samples'}}, opset_version=17, dynamo=False)
    # 8-bit weights: about 38 MB instead of 114 MB per voice and less memory, with the same voice.
    quantize_dynamic(full, os.path.join(dest, 'model.onnx'), weight_type=QuantType.QUInt8)
    os.remove(full)
    # The tokenizer is character based: these are all the settings the JavaScript side needs.
    tc = tok.get_vocab()
    meta = {'model': name, 'license': 'CC-BY-NC-4.0', 'sampleRate': model.config.sampling_rate, 'vocab': tc,
            'addBlank': bool(tok.add_blank),
            'normalize': bool(tok.normalize), 'phonemize': bool(tok.phonemize), 'isUroman': bool(getattr(tok, 'is_uroman', False))}
    json.dump(meta, open(os.path.join(dest, 'tokenizer.json'), 'w'), ensure_ascii=False)
    print(lang, 'ok', meta['sampleRate'], len(tc), meta['addBlank'], meta['normalize'], meta['phonemize'], meta['isUroman'])
