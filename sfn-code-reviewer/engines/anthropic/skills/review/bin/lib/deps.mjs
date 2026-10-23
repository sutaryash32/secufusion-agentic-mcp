// Deterministic dependency diff for pom.xml and package.json. Pure; unit-tested.
// Not a full Maven model: resolves ${properties} from the same pom, ignores parent/BOM inheritance
// (a version managed elsewhere shows as "managed").

export function parsePom(xml) {
  if (!xml) return {};
  const strip = (s) => s.replace(/<!--[\s\S]*?-->/g, '');
  const body = strip(xml);
  const props = {};
  const propsBlock = body.match(/<properties>([\s\S]*?)<\/properties>/)?.[1] ?? '';
  for (const m of propsBlock.matchAll(/<([\w.-]+)>\s*([^<]*?)\s*<\/\1>/g)) props[m[1]] = m[2];
  const project = body.match(/<project[\s\S]*?>[\s\S]*?<version>\s*([^<]+?)\s*<\/version>/);
  if (project) props['project.version'] = project[1];
  const resolve = (v) => (v ?? '').replace(/\$\{([^}]+)\}/g, (_, k) => props[k] ?? `\${${k}}`);

  const deps = {};
  // Only <dependencies> blocks; <dependencyManagement> is reported separately as "managed:".
  const managed = body.match(/<dependencyManagement>([\s\S]*?)<\/dependencyManagement>/)?.[1] ?? '';
  const direct = body.replace(/<dependencyManagement>[\s\S]*?<\/dependencyManagement>/, '').replace(/<plugins>[\s\S]*?<\/plugins>/g, '');
  const collect = (text, prefix) => {
    for (const m of text.matchAll(/<dependency>([\s\S]*?)<\/dependency>/g)) {
      const tag = (t) => m[1].match(new RegExp(`<${t}>\\s*([^<]+?)\\s*</${t}>`))?.[1];
      const g = tag('groupId');
      const a = tag('artifactId');
      if (!g || !a) continue;
      deps[`${prefix}${g}:${a}`] = { version: resolve(tag('version')) || 'managed', scope: tag('scope') ?? 'compile' };
    }
  };
  collect(direct, '');
  collect(managed, 'managed:');
  const parent = body.match(/<parent>([\s\S]*?)<\/parent>/)?.[1];
  if (parent) {
    const t = (x) => parent.match(new RegExp(`<${x}>\\s*([^<]+?)\\s*</${x}>`))?.[1];
    deps[`parent:${t('groupId')}:${t('artifactId')}`] = { version: resolve(t('version')), scope: 'parent' };
  }
  return deps;
}

export function parsePackageJson(text) {
  if (!text) return {};
  let pkg;
  try { pkg = JSON.parse(text); } catch { return {}; }
  const deps = {};
  for (const [section, scope] of [['dependencies', 'prod'], ['devDependencies', 'dev'], ['peerDependencies', 'peer'], ['optionalDependencies', 'optional']]) {
    for (const [name, version] of Object.entries(pkg[section] ?? {})) deps[name] = { version, scope };
  }
  return deps;
}

/** @returns {Array<{manifest, name, change:'added'|'removed'|'changed', from?, to?, scope, bump?}>} */
export function diffDeps(manifest, before, after) {
  const out = [];
  for (const [name, d] of Object.entries(after)) {
    const b = before[name];
    if (!b) out.push({ manifest, name, change: 'added', to: d.version, scope: d.scope });
    else if (b.version !== d.version || b.scope !== d.scope) {
      out.push({ manifest, name, change: 'changed', from: b.version, to: d.version, scope: d.scope, bump: semverBump(b.version, d.version) });
    }
  }
  for (const [name, b] of Object.entries(before)) {
    if (!after[name]) out.push({ manifest, name, change: 'removed', from: b.version, scope: b.scope });
  }
  return out;
}

export function semverBump(from, to) {
  const v = (s) => String(s ?? '').replace(/^[^\d]*/, '').split(/[.-]/).map((x) => Number.parseInt(x, 10));
  const [a, b] = [v(from), v(to)];
  if (Number.isNaN(a[0]) || Number.isNaN(b[0])) return 'unknown';
  if (a[0] !== b[0]) return b[0] > a[0] ? 'major' : 'downgrade';
  if ((a[1] || 0) !== (b[1] || 0)) return (b[1] || 0) > (a[1] || 0) ? 'minor' : 'downgrade';
  if ((a[2] || 0) !== (b[2] || 0)) return (b[2] || 0) > (a[2] || 0) ? 'patch' : 'downgrade';
  return 'other';
}

export function manifestKind(path) {
  if (/(^|\/)pom\.xml$/.test(path)) return 'pom';
  if (/(^|\/)package\.json$/.test(path)) return 'npm';
  return undefined;
}
