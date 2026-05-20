// ORT-Web 1.18+ exposes inputMetadata/outputMetadata as a readonly array of
// ValueMetadata ordered to match inputNames/outputNames. Older versions
// exposed it as a Record keyed by tensor name. Accept both shapes.
export function readMetaEntry(metaCollection, name, index = 0) {
  if (!metaCollection) return null;
  if (Array.isArray(metaCollection)) {
    if (name) {
      const byName = metaCollection.find((m) => m?.name === name);
      if (byName) return byName;
    }
    return metaCollection[index] || null;
  }
  return (name && metaCollection[name]) || null;
}

export function isFp16InputType(inputType) {
  return typeof inputType === 'string' && inputType.toLowerCase().includes('float16');
}
