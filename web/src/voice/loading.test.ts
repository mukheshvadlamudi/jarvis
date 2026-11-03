import { afterEach, expect, it, vi } from 'vitest';
import { modelLoadLabel, modelProgress } from './loading.ts';

afterEach(() => vi.unstubAllGlobals());

it('labels saved models without percentages and clears the line when usable', async () => {
  const open = vi.fn(async () => ({ keys: async () => [{ url: 'https://huggingface.co/org/model/resolve/main/onnx/model.onnx' }] }));
  vi.stubGlobal('caches', { open });
  const report = vi.fn();
  const progress = await modelProgress('org/model', ['onnx/model.onnx'], report);
  expect(open).toHaveBeenCalledWith('transformers-cache');
  expect(modelLoadLabel('voice', report.mock.calls[0][0])).toBe('Loading voice (saved on this device)');
  progress({ status: 'progress', file: 'onnx/model.onnx', loaded: 326e6, total: 326e6 });
  expect(report).toHaveBeenCalledTimes(1);
  expect(modelLoadLabel('voice', { status: 'ready', loaded: 326e6, total: 326e6 })).toBe('');
});

it('aggregates actual download bytes across files, replacing each file update', async () => {
  vi.stubGlobal('caches', { open: async () => ({ keys: async () => [] }) });
  const report = vi.fn();
  const progress = await modelProgress('org/model', ['encoder.onnx', 'decoder.onnx'], report);
  expect(modelLoadLabel('voice', report.mock.calls.at(-1)![0])).toBe('Downloading voice model');
  progress({ status: 'progress', file: 'encoder.onnx', loaded: 40e6, total: 200e6 });
  progress({ status: 'progress', file: 'decoder.onnx', loaded: 20e6, total: 126e6 });
  progress({ status: 'progress', file: 'encoder.onnx', loaded: 100e6, total: 200e6 });
  expect(modelLoadLabel('voice', report.mock.calls.at(-1)![0])).toBe('Downloading voice model · 120 of 326 MB');
});

it('excludes cached files from transferred bytes in a partially saved model', async () => {
  vi.stubGlobal('caches', { open: async () => ({ keys: async () => [{ url: 'https://huggingface.co/org/model/resolve/main/config.json' }] }) });
  const report = vi.fn();
  const progress = await modelProgress('org/model', ['config.json', 'model.onnx'], report);
  progress({ status: 'progress', file: 'config.json', loaded: 1000, total: 1000 });
  progress({ status: 'progress', file: 'model.onnx', loaded: 120e6, total: 326e6 });
  expect(report.mock.calls.at(-1)![0]).toMatchObject({ cached: false, loaded: 120e6, total: 326e6 });
});

it('handles blocked cache storage and unknown transfer sizes without a stuck zero', async () => {
  vi.stubGlobal('caches', { open: async () => { throw new Error('blocked'); } });
  const report = vi.fn();
  const progress = await modelProgress('org/model', ['model.onnx'], report);
  expect(modelLoadLabel('voice', report.mock.calls.at(-1)![0])).toBe('Loading voice');
  progress({ status: 'progress', file: 'model.onnx', loaded: 12e6 });
  expect(modelLoadLabel('voice', report.mock.calls.at(-1)![0])).toBe('Loading voice');
});

it('shows transferred bytes without a total when the server does not provide a size', async () => {
  vi.stubGlobal('caches', { open: async () => ({ keys: async () => [] }) });
  const report = vi.fn();
  const progress = await modelProgress('org/model', ['model.onnx'], report);
  progress({ status: 'progress', file: 'model.onnx', loaded: 12e6 });
  expect(modelLoadLabel('voice', report.mock.calls.at(-1)![0])).toBe('Downloading voice model · 12 MB');
});
