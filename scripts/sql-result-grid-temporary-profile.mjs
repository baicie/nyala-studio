import { rm } from 'node:fs/promises';

export async function stopBrowserProcess(browserProcess, { gracefulTimeoutMs = 3_000, forceTimeoutMs = 3_000 } = {}) {
	if (hasExited(browserProcess)) return;
	const gracefulExit = waitForExit(browserProcess, gracefulTimeoutMs);
	browserProcess.kill('SIGTERM');
	if (await gracefulExit) return;

	browserProcess.kill('SIGKILL');
	if (!(await waitForExit(browserProcess, forceTimeoutMs))) {
		throw new Error('Chrome did not exit after SIGKILL.');
	}
}

export async function removeTemporaryProfileRoot(
	path,
	{ remove = rm, retries = 20, retryDelayMs = 100, wait = delay } = {}
) {
	for (let attempt = 0; ; attempt += 1) {
		try {
			await remove(path, { recursive: true, force: true });
			return;
		} catch (error) {
			if (!isRetryableRemovalError(error) || attempt >= retries) throw error;
			await wait(retryDelayMs);
		}
	}
}

function hasExited(child) {
	return child.exitCode !== null || child.signalCode !== null;
}

function waitForExit(child, timeoutMs) {
	if (hasExited(child)) return Promise.resolve(true);
	return new Promise(resolve => {
		if (timeoutMs === undefined) {
			child.once('exit', () => resolve(true));
			if (hasExited(child)) resolve(true);
			return;
		}
		let timer;
		const finish = exited => {
			clearTimeout(timer);
			child.off('exit', onExit);
			resolve(exited);
		};
		const onExit = () => finish(true);
		child.once('exit', onExit);
		timer = setTimeout(() => finish(hasExited(child)), timeoutMs);
		if (hasExited(child)) finish(true);
	});
}

function isRetryableRemovalError(error) {
	return ['EBUSY', 'ENOTEMPTY', 'EPERM'].includes(error?.code);
}

function delay(milliseconds) {
	return new Promise(resolve => setTimeout(resolve, milliseconds));
}
