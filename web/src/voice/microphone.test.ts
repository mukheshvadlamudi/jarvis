import { expect, it, vi } from 'vitest';
import { openMicrophone, resolveMic } from './microphone.ts';

const mic = (deviceId: string, label = 'USB microphone') => ({ kind: 'audioinput' as const, deviceId, label });

it('uses default only when the selected device is gone, preserving hidden IDs before permission', () => {
  expect(resolveMic('', [mic('usb')])).toEqual({ micId: '', missing: false });
  expect(resolveMic('usb', [mic('usb')])).toEqual({ micId: 'usb', missing: false });
  expect(resolveMic('usb', [mic('built-in')])).toEqual({ micId: '', missing: true });
  expect(resolveMic('usb', [mic('', '')])).toEqual({ micId: 'usb', missing: false });
});

it('opens the selected device with exact constraints and the noise preference', async () => {
  const stream = {} as MediaStream;
  const media = { enumerateDevices: vi.fn(async () => [mic('usb')]), getUserMedia: vi.fn(async () => stream) };
  expect(await openMicrophone('usb', false, media as unknown as MediaDevices)).toEqual({ stream, missing: false });
  expect(media.getUserMedia).toHaveBeenCalledWith({ audio: { deviceId: { exact: 'usb' }, echoCancellation: true, noiseSuppression: false, autoGainControl: true, channelCount: 1 } });
});

it('retries default if a device disappears between enumeration and acquisition', async () => {
  const stream = {} as MediaStream;
  const media = { enumerateDevices: async () => [mic('usb')], getUserMedia: vi.fn().mockRejectedValueOnce(Object.assign(new Error('gone'), { name: 'OverconstrainedError', constraint: 'deviceId' })).mockResolvedValue(stream) };
  expect(await openMicrophone('usb', true, media as unknown as MediaDevices)).toEqual({ stream, missing: true });
  expect(media.getUserMedia).toHaveBeenLastCalledWith({ audio: expect.objectContaining({ deviceId: undefined }) });
});

it('does not hide permission failures by opening another device', async () => {
  const media = { enumerateDevices: async () => [mic('usb')], getUserMedia: vi.fn().mockRejectedValue(Object.assign(new Error('blocked'), { name: 'NotAllowedError' })) };
  await expect(openMicrophone('usb', true, media as unknown as MediaDevices)).rejects.toThrow('blocked');
  expect(media.getUserMedia).toHaveBeenCalledTimes(1);
});
