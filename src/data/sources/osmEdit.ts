/**
 * Direct edits for walkers signed in with OpenStreetMap (owner, 2026-11-28):
 * add one preset node, or delete one simple node. Each edit is its own small
 * changeset (create → upload → close) with a plain comment, so mappers can
 * review it at a glance. The XML is built by the pure `lib/osmChange.ts`.
 */

import { OSM_API_URL, OSM_PENDING_EDIT_MAX_AGE_MS, OSM_WEBSITE_URL, STORAGE_KEYS } from '../../config';
import {
  changesetTags,
  changesetXml,
  createNodeChange,
  deletableAs,
  deleteNodeChange,
  newNodeId,
  type OsmTags,
} from '../../lib/osmChange';
import { readStored, writeStored } from '../../lib/storage';
import type { OsmSession } from './osmAuth';

export type EditOutcome =
  | { readonly ok: true; readonly url: string; readonly nodeId: number }
  | { readonly ok: false; readonly message: string; readonly signedOut?: boolean; readonly useNote?: boolean };

class EditError extends Error {
  constructor(
    message: string,
    readonly signedOut = false,
    readonly useNote = false,
  ) {
    super(message);
  }
}

async function call(session: OsmSession, method: string, path: string, body?: string): Promise<Response> {
  let response: Response;
  try {
    response = await fetch(new URL(`/api/0.6/${path}`, OSM_API_URL), {
      method,
      credentials: 'omit',
      headers: { Authorization: `Bearer ${session.token}`, ...(body === undefined ? {} : { 'Content-Type': 'text/xml' }) },
      ...(body === undefined ? {} : { body }),
    });
  } catch {
    throw new EditError('Could not reach OpenStreetMap. Check your connection and try again.');
  }
  if (response.status === 401 || response.status === 403) {
    throw new EditError('Your OpenStreetMap sign-in has expired. Please sign in again.', true);
  }
  if (!response.ok) throw new EditError(`OpenStreetMap did not accept the change (HTTP ${response.status}).`);
  return response;
}

/** One changeset around one osmChange; always closed, even after a failed upload. */
async function inChangeset(
  session: OsmSession,
  comment: string,
  change: (changesetId: number) => string,
): Promise<string> {
  const created = await call(session, 'PUT', 'changeset/create', changesetXml(changesetTags(comment, window.location.origin)));
  const changesetId = Number((await created.text()).trim());
  if (!Number.isSafeInteger(changesetId)) throw new EditError('OpenStreetMap gave no changeset number.');
  try {
    const uploaded = await call(session, 'POST', `changeset/${changesetId}/upload`, change(changesetId));
    return await uploaded.text();
  } finally {
    await call(session, 'PUT', `changeset/${changesetId}/close`).catch(() => undefined);
  }
}

const toOutcome = (cause: unknown): EditOutcome => {
  if (cause instanceof EditError) return { ok: false, message: cause.message, signedOut: cause.signedOut, useNote: cause.useNote };
  console.warn('[osm edit] failed', cause);
  return { ok: false, message: 'Something went wrong talking to OpenStreetMap. Please try again.' };
};

export async function addNode(session: OsmSession, lat: number, lng: number, tags: OsmTags, label: string): Promise<EditOutcome> {
  try {
    const diff = await inChangeset(session, `Added a ${label.toLowerCase()} via PawPath`, (id) => createNodeChange(id, lat, lng, tags));
    const nodeId = newNodeId(diff);
    if (nodeId === undefined) throw new EditError('Added, but OpenStreetMap gave no node number.');
    rememberAdd({ nodeId, label, lat, lng, at: Date.now() });
    return { ok: true, nodeId, url: new URL(`/node/${nodeId}`, OSM_WEBSITE_URL).toString() };
  } catch (cause) {
    return toOutcome(cause);
  }
}

interface OsmElement {
  readonly id: number;
  readonly version: number;
  readonly lat: number;
  readonly lon: number;
  readonly tags?: OsmTags;
}

/**
 * Deletes the node only when it is safe: still the same kind of thing,
 * nothing else tagged on it, and not part of any way or relation. Otherwise
 * `useNote: true` — a note lets a mapper decide.
 */
export async function deleteNode(
  session: OsmSession,
  nodeId: number,
  kindTags: OsmTags,
  label: string,
  allowName: boolean,
): Promise<EditOutcome> {
  try {
    const nodeResponse = await call(session, 'GET', `node/${nodeId}.json`);
    const node = ((await nodeResponse.json()) as { elements?: OsmElement[] }).elements?.[0];
    if (node === undefined) throw new EditError('That point is already gone from OpenStreetMap.');
    if (!deletableAs(kindTags, node.tags ?? {}, allowName)) {
      throw new EditError('This point carries more than PawPath can judge, so a mapper should look at it.', false, true);
    }
    for (const parent of ['ways', 'relations'] as const) {
      const listed = await call(session, 'GET', `node/${nodeId}/${parent}.json`);
      if ((((await listed.json()) as { elements?: unknown[] }).elements ?? []).length > 0) {
        throw new EditError('This point is part of a larger feature, so a mapper should look at it.', false, true);
      }
    }
    await inChangeset(session, `Removed a ${label.toLowerCase()} that is no longer there, via PawPath`, (id) =>
      deleteNodeChange(id, node.id, node.version, node.lat, node.lon),
    );
    return { ok: true, nodeId, url: new URL(`/node/${nodeId}/history`, OSM_WEBSITE_URL).toString() };
  } catch (cause) {
    return toOutcome(cause);
  }
}

/* ------------------------------------------------------------------ *
 * Points added from this browser, shown until the weekly build has them.
 * ------------------------------------------------------------------ */

export interface PendingAdd {
  readonly nodeId: number;
  readonly label: string;
  readonly lat: number;
  readonly lng: number;
  readonly at: number;
}

const isPendingList = (v: unknown): v is PendingAdd[] =>
  Array.isArray(v) &&
  v.every((p) => typeof p === 'object' && p !== null && typeof (p as PendingAdd).nodeId === 'number' && typeof (p as PendingAdd).lat === 'number');

export function pendingAdds(now = Date.now()): PendingAdd[] {
  return (readStored(STORAGE_KEYS.osmPendingAdds, isPendingList) ?? []).filter((p) => now - p.at < OSM_PENDING_EDIT_MAX_AGE_MS);
}

function rememberAdd(add: PendingAdd): void {
  writeStored(STORAGE_KEYS.osmPendingAdds, [...pendingAdds(), add].slice(-50));
}
