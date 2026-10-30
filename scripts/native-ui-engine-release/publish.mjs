/*!
 * @webview-native-ui/engine
 * Copyright (c) 2026 Masahiko Sakakibara (rdlabo)
 * SPDX-License-Identifier: MIT
 */

import { setTimeout as delay } from 'node:timers/promises';

const api = 'https://central.sonatype.com/api/v1/publisher';

export async function publishBundle({ bundle, name, token, fetcher = fetch, wait = delay, record = console.log }) {
  const request = async (path, body) => {
    const response = await fetcher(`${api}/${path}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body,
      signal: AbortSignal.timeout(120_000),
      redirect: 'error',
    });
    // Do not include request headers or an untrusted response body in logs.
    if (!response.ok) throw new Error(`Central ${path.split('?')[0]} returned HTTP ${response.status}`);
    return response;
  };
  const form = new FormData();
  form.append('bundle', new Blob([bundle], { type: 'application/octet-stream' }), `${name}.zip`);
  const id = (await (await request(`upload?${new URLSearchParams({ name, publishingType: 'AUTOMATIC' })}`, form)).text()).trim();
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw new Error('Central returned an invalid deployment ID');
  await record(`Central deployment: ${id}`);
  // Never retry an upload: a timeout may have created a deployment already.
  let previousState;
  for (let attempt = 0; attempt < 80; attempt++) {
    const { deploymentState } = await (await request(`status?id=${id}`)).json();
    if (!['PENDING', 'VALIDATING', 'VALIDATED', 'PUBLISHING', 'PUBLISHED'].includes(deploymentState)) {
      throw new Error(`Central deployment ${id}: ${deploymentState}; inspect the Portal for details`);
    }
    if (deploymentState !== previousState) {
      await record(`Central deployment ${id}: ${deploymentState}`);
      previousState = deploymentState;
    }
    if (deploymentState === 'PUBLISHING' || deploymentState === 'PUBLISHED') return id;
    await wait(15_000);
  }
  throw new Error(`Central deployment ${id} did not reach publishing (last state: ${previousState}); inspect it before retrying`);
}
