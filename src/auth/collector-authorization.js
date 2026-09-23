// A helper process can finish device authorization and remove its pending file.
// Always adopt the atomic credential store, not just the result of our own poll.
export async function synchronizeCollectorAuthorization({ device, auth, onPendingError = () => {} }) {
  try {
    await device.poll();
  } catch (error) {
    if (error?.code !== 'ENOENT') onPendingError();
  }
  await auth.load();
}
