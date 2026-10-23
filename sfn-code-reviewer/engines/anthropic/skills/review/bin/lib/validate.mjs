// Dependency-free validator for the JSON-Schema subset our schemas use:
// type, enum, const, required, properties, additionalProperties:false, items, pattern,
// minLength, maxLength, minimum, $ref (by $id file name). Returns a list of error strings.

export function createValidator(schemas) {
  const byName = new Map();
  for (const s of schemas) byName.set(s.$id.split('/').pop(), s);

  function check(schema, value, path, errors) {
    if (schema.$ref) {
      const target = byName.get(schema.$ref.split('/').pop());
      if (!target) throw new Error(`Unresolved $ref ${schema.$ref}`);
      return check(target, value, path, errors);
    }
    if ('const' in schema && value !== schema.const) {
      errors.push(`${path}: must be ${JSON.stringify(schema.const)}`);
      return;
    }
    if (schema.enum && !schema.enum.includes(value)) {
      errors.push(`${path}: must be one of ${schema.enum.join(', ')} (got ${JSON.stringify(value)})`);
      return;
    }
    if (schema.type && !typeOk(schema.type, value)) {
      errors.push(`${path}: must be ${schema.type}`);
      return;
    }
    if (typeof value === 'string') {
      if (schema.minLength != null && value.length < schema.minLength) errors.push(`${path}: too short`);
      if (schema.maxLength != null && value.length > schema.maxLength) errors.push(`${path}: too long`);
      if (schema.pattern && !new RegExp(schema.pattern).test(value)) errors.push(`${path}: must match ${schema.pattern}`);
    }
    if (typeof value === 'number' && schema.minimum != null && value < schema.minimum) {
      errors.push(`${path}: must be >= ${schema.minimum}`);
    }
    if (Array.isArray(value) && schema.items) {
      value.forEach((v, i) => check(schema.items, v, `${path}[${i}]`, errors));
    }
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      for (const key of schema.required ?? []) {
        if (!(key in value)) errors.push(`${path}: missing "${key}"`);
      }
      const props = schema.properties ?? {};
      for (const [key, v] of Object.entries(value)) {
        if (props[key]) check(props[key], v, `${path}.${key}`, errors);
        else if (schema.additionalProperties === false) errors.push(`${path}: unexpected "${key}"`);
      }
    }
  }

  return (schemaName, value) => {
    const errors = [];
    check(byName.get(schemaName), value, '$', errors);
    return errors;
  };
}

function typeOk(type, v) {
  switch (type) {
    case 'object': return v !== null && typeof v === 'object' && !Array.isArray(v);
    case 'array': return Array.isArray(v);
    case 'string': return typeof v === 'string';
    case 'integer': return Number.isInteger(v);
    case 'number': return typeof v === 'number';
    case 'boolean': return typeof v === 'boolean';
    default: return true;
  }
}

/** Pulls the result object out of whatever the engine printed (raw JSON, CLI envelope, or fenced block). */
export function extractResult(text) {
  const tryParse = (s) => { try { return JSON.parse(s); } catch { return undefined; } };
  let obj = tryParse(text.trim());
  if (obj && typeof obj === 'object') {
    // claude -p --output-format json envelope; an API/CLI failure is not a result.
    if (obj.type === 'result' && obj.is_error) return undefined;
    if (obj.structured_output && typeof obj.structured_output === 'object') return obj.structured_output;
    if (typeof obj.result === 'string') return extractResult(obj.result);
    if ('verdict' in obj || 'findings' in obj) return obj;
  }
  const fences = [...text.matchAll(/```(?:json)?\s*\n([\s\S]*?)\n```/g)].map((m) => m[1]);
  for (const body of fences.reverse()) {
    obj = tryParse(body);
    if (obj && typeof obj === 'object' && ('verdict' in obj || 'findings' in obj)) return obj;
  }
  const first = text.indexOf('{');
  const last = text.lastIndexOf('}');
  if (first !== -1 && last > first) {
    obj = tryParse(text.slice(first, last + 1));
    if (obj && typeof obj === 'object' && ('verdict' in obj || 'findings' in obj)) return obj;
  }
  return undefined;
}
