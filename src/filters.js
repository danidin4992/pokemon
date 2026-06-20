function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Word-boundary, case-insensitive match.
// "9" matches "PSA 9" and "Grade 9" but NOT "1995" or "PSA9.5"
function containsKeyword(title, keyword) {
  if (!keyword) return false;
  const kw = keyword.trim();
  if (!kw) return false;
  const re = new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRegex(kw)}(?=[^\\p{L}\\p{N}]|$)`, 'iu');
  return re.test(title);
}

function parseList(v) {
  if (!v) return [];
  if (Array.isArray(v)) return v.filter(Boolean);
  try {
    const parsed = JSON.parse(v);
    return Array.isArray(parsed) ? parsed.filter(Boolean) : [];
  } catch {
    return [];
  }
}

// A listing passes if:
//   - global required (any-of) is empty OR title matches at least one
//   - per-search required (any-of) is empty OR title matches at least one
//   - title matches NONE of (global forbidden ∪ per-search forbidden)
export function matchesListing(title, search, settings) {
  if (!title) return false;

  const globalRequired = parseList(settings.global_required_keywords);
  const globalForbidden = parseList(settings.global_forbidden_keywords);
  const searchRequired = parseList(search.required_keywords);
  const searchForbidden = parseList(search.forbidden_keywords);

  if (globalRequired.length && !globalRequired.some((k) => containsKeyword(title, k))) {
    return false;
  }
  if (searchRequired.length && !searchRequired.some((k) => containsKeyword(title, k))) {
    return false;
  }

  const allForbidden = [...globalForbidden, ...searchForbidden];
  if (allForbidden.some((k) => containsKeyword(title, k))) {
    return false;
  }

  return true;
}

export { containsKeyword };
