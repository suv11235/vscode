/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Prooftree. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { spawn } from 'child_process';

export interface CheckRun {
	readonly result: 'pass' | 'fail';
	readonly exitCode: number | null;
	readonly timedOut: boolean;
	readonly durationMs: number;
	/** The last few kilobytes of combined output. */
	readonly output: string;
}

const OUTPUT_LIMIT = 4000;

export function runCommand(command: string, cwd: string, timeoutSeconds: number): Promise<CheckRun> {
	const started = Date.now();
	return new Promise(resolve => {
		const child = spawn(command, { cwd, shell: true, stdio: ['ignore', 'pipe', 'pipe'] });
		let output = '';
		let timedOut = false;
		const append = (chunk: Buffer) => {
			output = (output + chunk.toString('utf8')).slice(-OUTPUT_LIMIT);
		};
		child.stdout.on('data', append);
		child.stderr.on('data', append);

		const timer = setTimeout(() => {
			timedOut = true;
			child.kill('SIGTERM');
		}, timeoutSeconds * 1000);

		const finish = (exitCode: number | null, error?: Error) => {
			clearTimeout(timer);
			if (error) {
				append(Buffer.from(String(error)));
			}
			resolve({
				result: exitCode === 0 && !timedOut ? 'pass' : 'fail',
				exitCode,
				timedOut,
				durationMs: Date.now() - started,
				output,
			});
		};
		child.on('error', error => finish(null, error));
		child.on('close', code => finish(code));
	});
}
