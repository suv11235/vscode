/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Prooftree. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Bundles the Prooftree CLI into one file that a repository can commit and run in CI
// (`node .prooftree/bin/prooftree.cjs ci`) without installing this extension.
import esbuild from 'esbuild';
import * as path from 'node:path';

await esbuild.build({
	entryPoints: [path.join(import.meta.dirname, 'src', 'cli', 'main.ts')],
	outfile: path.join(import.meta.dirname, 'dist', 'prooftree.cjs'),
	bundle: true,
	platform: 'node',
	format: 'cjs',
	target: 'node20',
	banner: { js: '#!/usr/bin/env node\n// Prooftree CLI, bundled from extensions/prooftree in the Prooftree VS Code fork.' },
	logLevel: 'warning',
});
