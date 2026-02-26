import { loadCloudflareConfig } from './config.js';

async function _d1Request(sql, params = []) {
  const { accountId, databaseId, apiToken } = loadCloudflareConfig();
  const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/d1/database/${databaseId}/query`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ sql, params }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`D1 request failed (${res.status}): ${text}`);
  }
  const json = await res.json();
  if (!json.success) {
    throw new Error(`D1 error: ${JSON.stringify(json.errors)}`);
  }
  return json.result[0];
}

export async function d1Query(sql, params = []) {
  const result = await _d1Request(sql, params);
  return result?.results ?? [];
}

export async function d1Exec(sql, params = []) {
  const result = await _d1Request(sql, params);
  return { changes: result?.meta?.changes ?? 0 };
}
