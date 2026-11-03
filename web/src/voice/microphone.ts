export function resolveMic(micId: string, devices: Pick<MediaDeviceInfo, 'kind' | 'deviceId' | 'label'>[]) {
  // Before permission, device IDs can be hidden too; let getUserMedia decide.
  const missing = !!micId && devices.some((d) => d.kind === 'audioinput' && d.label) &&
    !devices.some((d) => d.kind === 'audioinput' && d.deviceId === micId);
  return { micId: missing ? '' : micId, missing };
}

export async function openMicrophone(micId: string, noiseSuppression: boolean, media = navigator.mediaDevices) {
  const selection = resolveMic(micId, await media.enumerateDevices());
  const open = (id: string) => media.getUserMedia({ audio: {
    deviceId: id ? { exact: id } : undefined,
    echoCancellation: true, noiseSuppression, autoGainControl: true, channelCount: 1,
  } });
  try {
    return { stream: await open(selection.micId), missing: selection.missing };
  } catch (err) {
    if (!selection.micId || !['NotFoundError', 'OverconstrainedError'].includes((err as Error).name) ||
      ((err as OverconstrainedError).constraint && (err as OverconstrainedError).constraint !== 'deviceId')) throw err;
    return { stream: await open(''), missing: true };
  }
}
