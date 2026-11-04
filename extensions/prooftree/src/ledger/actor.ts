/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Prooftree. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { execFileSync } from 'child_process';
import * as os from 'os';
import { Actor } from './model';

/** The person at this machine: git's user.name in `cwd`, or the OS user. */
export function localHuman(cwd: string): Actor {
	try {
		const name = execFileSync('git', ['config', 'user.name'], { cwd, encoding: 'utf8' }).trim();
		if (name) {
			return { kind: 'human', name };
		}
	} catch {
		// git is missing or has no user configured
	}
	return { kind: 'human', name: os.userInfo().username };
}
