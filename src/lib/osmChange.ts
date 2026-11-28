/**
 * The OSM API 0.6 documents a signed-in walker's edit is made of — pure, so
 * the exact bytes sent to OpenStreetMap are tested without a network.
 *
 * Only two edits exist: add one tagged node (a bench, bin, tap…), or delete
 * one simple node. Never ways, never free tag editing (owner, 2026-11-28:
 * phone edits stay small and preset-based).
 */

import { OSM_DELETABLE_EXTRA_KEYS } from '../config';

export type OsmTags = Readonly<Record<string, string>>;

const escapeXml = (text: string): string =>
  text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '');

const tagLines = (tags: OsmTags, indent: string): string =>
  Object.entries(tags)
    .map(([k, v]) => `${indent}<tag k="${escapeXml(k)}" v="${escapeXml(v.slice(0, 255))}"/>`)
    .join('\n');

/** Body of `PUT /api/0.6/changeset/create`. */
export function changesetXml(tags: OsmTags): string {
  return ['<osm>', '  <changeset>', tagLines(tags, '    '), '  </changeset>', '</osm>'].join('\n');
}

/** The changeset's tags: who made it and what, in one plain sentence. */
export function changesetTags(comment: string, appUrl: string): OsmTags {
  return { created_by: 'PawPath', comment: comment.slice(0, 255), host: appUrl };
}

/** osmChange creating one node (placeholder id -1). */
export function createNodeChange(changesetId: number, lat: number, lon: number, tags: OsmTags): string {
  return [
    '<osmChange version="0.6" generator="PawPath">',
    '  <create>',
    `    <node id="-1" changeset="${changesetId}" lat="${lat.toFixed(7)}" lon="${lon.toFixed(7)}">`,
    tagLines(tags, '      '),
    '    </node>',
    '  </create>',
    '</osmChange>',
  ].join('\n');
}

/** osmChange deleting one node at a known version (OSM refuses a stale version). */
export function deleteNodeChange(changesetId: number, nodeId: number, version: number, lat: number, lon: number): string {
  return [
    '<osmChange version="0.6" generator="PawPath">',
    '  <delete>',
    `    <node id="${nodeId}" version="${version}" changeset="${changesetId}" lat="${lat.toFixed(7)}" lon="${lon.toFixed(7)}"/>`,
    '  </delete>',
    '</osmChange>',
  ].join('\n');
}

/** The new node id from the upload's `<diffResult>`. */
export function newNodeId(diffResult: string): number | undefined {
  const match = /<node[^>]*old_id="-1"[^>]*new_id="(\d+)"/.exec(diffResult) ?? /<node[^>]*new_id="(\d+)"[^>]*old_id="-1"/.exec(diffResult);
  const id = match?.[1] === undefined ? NaN : Number(match[1]);
  return Number.isSafeInteger(id) && id > 0 ? id : undefined;
}

/** `https://www.openstreetmap.org/node/123` → node 123. */
export function parseOsmUrl(url: string | undefined): { type: 'node' | 'way' | 'relation'; id: number } | undefined {
  const match = url === undefined ? null : /\/(node|way|relation)\/(\d+)$/.exec(url);
  if (match === null) return undefined;
  const id = Number(match[2]);
  return Number.isSafeInteger(id) && id > 0 ? { type: match[1] as 'node' | 'way' | 'relation', id } : undefined;
}

/**
 * Whether "not there anymore" may delete this node outright: it must carry
 * the kind's own tags, and nothing beyond a short list of descriptive keys
 * (`name` included only for toilets, which are often named). A node that is
 * part of a way or relation is never deleted — the caller checks that.
 */
export function deletableAs(kindTags: OsmTags, nodeTags: OsmTags, allowName: boolean): boolean {
  for (const [k, v] of Object.entries(kindTags)) {
    // The bag dispenser's `amenity=vending_machine` is often left out in OSM.
    if (k === 'amenity' && kindTags['vending'] !== undefined && nodeTags[k] === undefined) continue;
    if (nodeTags[k] !== v) return false;
  }
  const allowed = new Set<string>([...OSM_DELETABLE_EXTRA_KEYS, ...Object.keys(kindTags), ...(allowName ? ['name'] : [])]);
  return Object.keys(nodeTags).every((k) => allowed.has(k));
}
