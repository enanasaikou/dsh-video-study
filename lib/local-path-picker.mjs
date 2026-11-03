// Only an explicit settings button may invoke the host's native folder dialog.
// No browser uploads, workspace root grants, shell commands or file contents.
import { stat } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';

export class PathPickerError extends Error {
  constructor(code) { super('本机路径选择未完成。'); this.code = code; }
}
const safePath = value => typeof value === 'string' && value.length <= 4096
  && !/[\x00-\x1f\x7f]/.test(value) && isAbsolute(value)
  && !/^[\\/]{2}/.test(value);

export function createLocalPathPicker({ getCapability, statImpl = stat, platform = process.platform,
  timeoutMs = 120000 } = {}) {
  let active = false, disposed = false, currentController;
  // Resolve a directory already chosen by the desktop's owner-window dialog.
  // This route never opens another dialog or runs an interpreter.
  const resolvePath = async (field, selected, { signal } = {}) => {
    if (disposed) throw new PathPickerError('picker_unavailable');
    if (!['pythonPath', 'localModelDir'].includes(field)) throw new PathPickerError('invalid_input');
    if (signal?.aborted) return { status: 'ok', cancelled: true };
    if (!safePath(selected)) throw new PathPickerError('picker_failed');
    try {
      const directory = await statImpl(selected);
      if (signal?.aborted) return { status: 'ok', cancelled: true };
      if (!directory.isDirectory()) throw new PathPickerError('picker_failed');
      if (field === 'localModelDir') return { status: 'ok', cancelled: false, path: selected };
      const candidates = platform === 'win32' ? ['python.exe', join('Scripts', 'python.exe')]
        : [join('bin', 'python3'), join('bin', 'python'), 'python3', 'python'];
      for (const name of candidates) {
        if (signal?.aborted) return { status: 'ok', cancelled: true };
        const candidate = join(selected, name);
        try {
          if ((await statImpl(candidate)).isFile()) {
            if (signal?.aborted) return { status: 'ok', cancelled: true };
            return { status: 'ok', cancelled: false, path: candidate };
          }
        } catch { /* Fixed candidates only. */ }
      }
      throw new PathPickerError('python_not_found');
    } catch (error) {
      if (signal?.aborted) return { status: 'ok', cancelled: true };
      if (error instanceof PathPickerError) throw error;
      throw new PathPickerError('picker_failed');
    }
  };
  const pickPath = async function (field, { signal } = {}) {
    if (disposed) throw new PathPickerError('picker_unavailable');
    if (!['pythonPath', 'localModelDir'].includes(field)) throw new PathPickerError('invalid_input');
    if (signal?.aborted) return { status: 'ok', cancelled: true };
    if (active) throw new PathPickerError('picker_busy');
    let capability;
    try { capability = getCapability?.(); } catch { /* unavailable is static */ }
    if (capability?.kind !== 'native' || typeof capability.pick !== 'function')
      throw new PathPickerError('picker_unavailable');
    active = true;
    const controller = new AbortController(); currentController = controller;
    const abort = () => controller.abort();
    const timer = setTimeout(abort, timeoutMs); timer.unref?.();
    signal?.addEventListener('abort', abort, { once: true });
    let pending, onAbort;
    try {
      if (signal?.aborted) controller.abort();
      if (controller.signal.aborted) return { status: 'ok', cancelled: true };
      pending = Promise.resolve().then(() => capability.pick(controller.signal));
      // Keep the busy gate until the real native request settles, even if a
      // buggy host ignores AbortSignal. Late results must never change a draft.
      void pending.then(() => { active = false; }, () => { active = false; });
      const cancelled = new Promise(resolve => {
        onAbort = () => resolve(null);
        controller.signal.addEventListener('abort', onAbort, { once: true });
        if (controller.signal.aborted) resolve(null);
      });
      const selected = await Promise.race([pending, cancelled]);
      if (controller.signal.aborted || selected === null) return { status: 'ok', cancelled: true };
      return await resolvePath(field, selected, { signal: controller.signal });
    } catch (error) {
      if (controller.signal.aborted) return { status: 'ok', cancelled: true };
      if (error instanceof PathPickerError) throw error;
      throw new PathPickerError('picker_failed');
    } finally {
      clearTimeout(timer); signal?.removeEventListener('abort', abort);
      if (onAbort) controller.signal.removeEventListener('abort', onAbort);
      if (!pending) active = false;
      if (currentController === controller) currentController = undefined;
    }
  };
  pickPath.resolve = resolvePath;
  pickPath.dispose = () => { disposed = true; currentController?.abort(); };
  return pickPath;
}
