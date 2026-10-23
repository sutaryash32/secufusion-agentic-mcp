/**
 * Bounded lifecycle model checker: find the sequence of operations that breaks an invariant, instead of arguing about it.
 *
 * The pessimistic review reasons in prose about zombie states (zero owners, two owners, an owner who is inactive). This
 * module searches for them. The reviewer writes a small model of the entity from the code (variables, operations with a
 * guard and effects, invariants); the checker explores every operation order, and for concurrent actors every
 * interleaving, and returns the SHORTEST sequence that violates an invariant.
 *
 * Language-neutral by design: the model is data, so it works for a service written in any language.
 *
 * Model:
 *   variables   name -> { type: "bool" | "int" | "enum", init, min?, max?, values? }
 *   operations  [{ name, requires?, effects: ["x = expr", ...], atomic?, lock? }]
 *   invariants  [{ name, expr }]
 *   mode        "sequential" (one actor, up to max_depth operations) | "concurrent" (actors, each doing ops_per_actor ops)
 * A NON-atomic operation is a check-then-act: `requires` is evaluated in one step and `effects` are applied in a LATER
 * step without re-checking, so another actor can change the world in between (the classic race). A `lock` makes the two
 * steps exclusive among operations that share the lock name.
 * Expressions: variables, numbers, true/false, "strings", ! && || == != < <= > >= + - * ( ) and count(a, b, ...) which is
 * the number of truthy arguments (handy for "exactly one").
 */
// ---------------------------------------------------------------- expression parser
function tokenize(src) {
    const toks = [];
    const re = /\s*(?:(==|!=|<=|>=|&&|\|\||[()!<>+\-*,])|("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')|(\d+(?:\.\d+)?)|([A-Za-z_][A-Za-z0-9_.]*))/y;
    let i = 0;
    while (i < src.length) {
        if (/^\s*$/.test(src.slice(i)))
            break;
        re.lastIndex = i;
        const m = re.exec(src);
        if (!m)
            throw new Error(`unexpected character at "${src.slice(i, i + 12)}" in expression: ${src}`);
        toks.push(m[1] ?? m[2] ?? m[3] ?? m[4]);
        i = re.lastIndex;
    }
    return toks;
}
function parseExpr(src) {
    const t = tokenize(src);
    let p = 0;
    const peek = () => t[p];
    const eat = (x) => {
        const v = t[p++];
        if (x && v !== x)
            throw new Error(`expected "${x}" but found "${v ?? "end"}" in: ${src}`);
        return v;
    };
    const prec = { "||": 1, "&&": 2, "==": 3, "!=": 3, "<": 4, "<=": 4, ">": 4, ">=": 4, "+": 5, "-": 5, "*": 6 };
    function primary() {
        const v = peek();
        if (v === undefined)
            throw new Error(`unexpected end of expression: ${src}`);
        if (v === "!") {
            eat();
            return { k: "not", e: primary() };
        }
        if (v === "-") {
            eat();
            return { k: "bin", op: "-", l: { k: "lit", v: 0 }, r: primary() };
        }
        if (v === "(") {
            eat();
            const e = expr(0);
            eat(")");
            return e;
        }
        eat();
        if (v === "true")
            return { k: "lit", v: true };
        if (v === "false")
            return { k: "lit", v: false };
        if (/^["']/.test(v))
            return { k: "lit", v: v.slice(1, -1) };
        if (/^\d/.test(v))
            return { k: "lit", v: Number(v) };
        if (v === "count" && peek() === "(") {
            eat("(");
            const args = [];
            if (peek() !== ")") {
                args.push(expr(0));
                while (peek() === ",") {
                    eat(",");
                    args.push(expr(0));
                }
            }
            eat(")");
            return { k: "count", args };
        }
        if (/^[A-Za-z_]/.test(v))
            return { k: "var", n: v };
        throw new Error(`unexpected token "${v}" in: ${src}`);
    }
    function expr(min) {
        let l = primary();
        for (;;) {
            const op = peek();
            const pr = op !== undefined ? prec[op] : undefined;
            if (pr === undefined || pr < min)
                break;
            eat();
            l = { k: "bin", op, l, r: expr(pr + 1) };
        }
        return l;
    }
    const e = expr(0);
    if (p < t.length)
        throw new Error(`unexpected "${t[p]}" in: ${src}`);
    return e;
}
function evalExpr(e, env) {
    switch (e.k) {
        case "lit": return e.v;
        case "var": {
            if (!(e.n in env))
                throw new Error(`unknown variable "${e.n}"`);
            return env[e.n];
        }
        case "not": return !evalExpr(e.e, env);
        case "count": return e.args.reduce((n, a) => n + (evalExpr(a, env) ? 1 : 0), 0);
        case "bin": {
            if (e.op === "&&")
                return !!evalExpr(e.l, env) && !!evalExpr(e.r, env);
            if (e.op === "||")
                return !!evalExpr(e.l, env) || !!evalExpr(e.r, env);
            const a = evalExpr(e.l, env), b = evalExpr(e.r, env);
            switch (e.op) {
                case "==": return a === b;
                case "!=": return a !== b;
                case "<": return a < b;
                case "<=": return a <= b;
                case ">": return a > b;
                case ">=": return a >= b;
                case "+": return a + b;
                case "-": return a - b;
                case "*": return a * b;
            }
            throw new Error(`unknown operator ${e.op}`);
        }
    }
}
const key = (n) => JSON.stringify([n.env, n.pcs.map((p) => [p.done, p.pending]), n.lockHolder]);
export function checkModel(model) {
    const errors = [];
    const notes = [];
    const mode = model.mode ?? "sequential";
    const maxStates = Math.max(1000, Math.min(model.max_states ?? 200_000, 2_000_000));
    const init = {};
    for (const [name, spec] of Object.entries(model.variables ?? {}))
        init[name] = spec.init;
    const domainError = (name, v) => {
        const s = model.variables[name];
        if (!s)
            return `assignment to undeclared variable "${name}"`;
        if (s.type === "bool" && typeof v !== "boolean")
            return `"${name}" is bool but was assigned ${JSON.stringify(v)}`;
        if (s.type === "int") {
            if (typeof v !== "number")
                return `"${name}" is int but was assigned ${JSON.stringify(v)}`;
            if (s.min !== undefined && v < s.min)
                return `"${name}" = ${v} is below its minimum ${s.min}`;
            if (s.max !== undefined && v > s.max)
                return `"${name}" = ${v} is above its maximum ${s.max}`;
        }
        if (s.type === "enum" && !s.values.includes(v))
            return `"${name}" = ${JSON.stringify(v)} is not one of ${s.values.join(", ")}`;
        return null;
    };
    let ops = [];
    let invs = [];
    try {
        ops = (model.operations ?? []).map((o) => ({
            name: o.name,
            requires: o.requires ? parseExpr(o.requires) : null,
            effects: (o.effects ?? []).map((s) => {
                const m = /^\s*([A-Za-z_][A-Za-z0-9_.]*)\s*=(?!=)\s*([\s\S]+)$/.exec(s);
                if (!m)
                    throw new Error(`effect must look like "variable = expression": ${s}`);
                return { target: m[1], rhs: parseExpr(m[2]) };
            }),
            atomic: o.atomic !== false,
            lock: o.lock,
        }));
        invs = (model.invariants ?? []).map((i) => ({ name: i.name, e: parseExpr(i.expr) }));
        // fail fast on unknown variables
        for (const o of ops)
            for (const f of [o.requires, ...o.effects.map((x) => x.rhs)])
                if (f)
                    evalExpr(f, init);
        for (const i of invs)
            evalExpr(i.e, init);
    }
    catch (e) {
        errors.push(e.message);
        return { ok: false, mode, states_explored: 0, truncated: false, violations: [], model_errors: errors, notes };
    }
    if (invs.length === 0)
        errors.push("the model has no invariants: nothing to check");
    if (ops.length === 0)
        errors.push("the model has no operations");
    if (errors.length)
        return { ok: false, mode, states_explored: 0, truncated: false, violations: [], model_errors: errors, notes };
    const holds = (env, e) => !!evalExpr(e, env);
    const actors = mode === "concurrent" ? Math.max(2, Math.min(model.actors ?? 2, 3)) : 1;
    const opsPerActor = mode === "concurrent" ? Math.max(1, Math.min(model.ops_per_actor ?? 1, 3)) : Math.max(1, Math.min(model.max_depth ?? 6, 12));
    const apply = (o, env) => {
        const next = { ...env };
        for (const ef of o.effects) {
            const v = evalExpr(ef.rhs, env); // all right-hand sides read the pre-state
            const de = domainError(ef.target, v);
            if (de)
                errors.push(`${o.name}: ${de}`);
            next[ef.target] = v;
        }
        return next;
    };
    const nodes = [{ env: init, pcs: Array.from({ length: actors }, () => ({ done: 0, pending: null, snapshotOk: false })), lockHolder: {}, parent: -1, step: "initial state" }];
    const seen = new Map([[key(nodes[0]), 0]]);
    const violations = [];
    const reported = new Set();
    let truncated = false;
    const traceOf = (idx) => {
        const t = [];
        for (let i = idx; i > 0; i = nodes[i].parent)
            t.push(nodes[i].step);
        return t.reverse();
    };
    const checkInvs = (idx) => {
        const n = nodes[idx];
        for (const iv of invs) {
            if (!holds(n.env, iv.e) && !reported.has(iv.name)) {
                reported.add(iv.name);
                violations.push({ invariant: iv.name, trace: traceOf(idx), final_state: n.env });
            }
        }
    };
    checkInvs(0);
    for (let head = 0; head < nodes.length; head++) {
        if (violations.length >= invs.length)
            break; // one shortest counterexample per invariant is enough
        const cur = nodes[head];
        const push = (n) => {
            const k = key(n);
            if (seen.has(k))
                return;
            if (nodes.length >= maxStates) {
                truncated = true;
                return;
            }
            seen.set(k, nodes.length);
            nodes.push(n);
            checkInvs(nodes.length - 1);
        };
        for (let a = 0; a < actors; a++) {
            const pc = cur.pcs[a];
            const label = actors > 1 ? `actor ${a + 1}: ` : "";
            if (pc.pending !== null) {
                // second half of a non-atomic operation: apply the effects WITHOUT re-checking the guard
                const o = ops[pc.pending];
                const pcs = cur.pcs.map((p, i) => (i === a ? { done: p.done + 1, pending: null, snapshotOk: false } : p));
                const lockHolder = { ...cur.lockHolder };
                if (o.lock && lockHolder[o.lock] === a)
                    delete lockHolder[o.lock];
                push({ env: apply(o, cur.env), pcs, lockHolder, parent: head, step: `${label}acts: ${o.name} (applies effects; the check was made earlier)` });
                continue;
            }
            if (pc.done >= opsPerActor)
                continue;
            ops.forEach((o, oi) => {
                if (o.lock && cur.lockHolder[o.lock] !== undefined)
                    return; // someone else holds this lock
                const ok = o.requires ? holds(cur.env, o.requires) : true;
                if (!ok)
                    return; // a failed check changes nothing
                if (o.atomic) {
                    const pcs = cur.pcs.map((p, i) => (i === a ? { done: p.done + 1, pending: null, snapshotOk: false } : p));
                    push({ env: apply(o, cur.env), pcs, lockHolder: cur.lockHolder, parent: head, step: `${label}${o.name} (atomic)` });
                }
                else {
                    const pcs = cur.pcs.map((p, i) => (i === a ? { done: p.done, pending: oi, snapshotOk: true } : p));
                    const lockHolder = o.lock ? { ...cur.lockHolder, [o.lock]: a } : cur.lockHolder;
                    push({ env: cur.env, pcs, lockHolder, parent: head, step: `${label}checks: ${o.name} (guard passes)` });
                }
            });
        }
    }
    if (truncated)
        notes.push(`state limit ${maxStates} reached: the search is incomplete, so "no violation" is not a proof`);
    if (mode === "sequential")
        notes.push(`explored every sequence of up to ${opsPerActor} operation(s)`);
    else
        notes.push(`explored every interleaving of ${actors} actors doing up to ${opsPerActor} operation(s) each; a non-atomic operation is a check step followed by an act step`);
    notes.push("the result is only as true as the model: every guard and effect must be traced to code with file:line before it is reported as a finding");
    return { ok: violations.length === 0 && errors.length === 0 && !truncated, mode, states_explored: nodes.length, truncated, violations, model_errors: [...new Set(errors)], notes };
}
export function renderCheck(name, r) {
    const out = [`# Lifecycle model check${name ? `: ${name}` : ""}`, `mode ${r.mode} · ${r.states_explored} state(s) explored${r.truncated ? " · TRUNCATED" : ""}`, ""];
    if (r.model_errors.length)
        out.push("MODEL ERRORS:", ...r.model_errors.map((e) => `  - ${e}`), "");
    if (r.violations.length === 0)
        out.push(r.truncated || r.model_errors.length ? "No violation found, but the search is not conclusive (see notes)." : "No invariant can be violated within the bounds.");
    for (const v of r.violations) {
        out.push(`VIOLATION of "${v.invariant}" — shortest sequence (${v.trace.length} step(s)):`);
        v.trace.forEach((s, i) => out.push(`  ${i + 1}. ${s}`));
        out.push(`  final state: ${JSON.stringify(v.final_state)}`, "");
    }
    out.push("", ...r.notes.map((n) => `note: ${n}`));
    return out.join("\n");
}
