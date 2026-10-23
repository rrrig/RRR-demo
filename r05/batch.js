// Match source metadata only. A local display name is not evidence of file identity.
// An automatic match suggests a target; it does not certify the file contents.
export function buildFilePlan(snapshot, files, {maxFileBytes = 20 * 1024 * 1024} = {}) {
  const selected = Array.from(files || []);
  const sources = new Map();
  const key = (name, size) => JSON.stringify([name.normalize('NFC'), size]);
  for (const revision of snapshot?.revisions || []) {
    const source = revision.source;
    if (source?.kind !== 'chatgpt-library' || typeof source.fileName !== 'string' || !Number.isSafeInteger(source.sizeBytes)) continue;
    const identity = key(source.fileName, source.sizeBytes);
    if (!sources.has(identity)) sources.set(identity, []);
    sources.get(identity).push(revision);
  }
  return selected.map((file, index) => {
    const fileName = typeof file?.name === 'string' ? file.name : '';
    const size = file?.size;
    const matches = fileName && Number.isSafeInteger(size) && size >= 0 ? sources.get(key(fileName, size)) || [] : [];
    const candidateIds = matches.map(revision => revision.id);
    let reason = 'unmatched', revisionId = null;
    if (Number.isSafeInteger(size) && size > maxFileBytes) reason = 'too-large';
    else if (matches.length > 1) reason = 'ambiguous';
    else if (matches.length === 1) {
      if (matches[0].attachment) reason = 'occupied';
      else { reason = 'matched'; revisionId = matches[0].id; }
    }
    return {index, file, fileName, size, revisionId, reason, candidateIds};
  });
}
