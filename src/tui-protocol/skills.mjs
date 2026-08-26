import path from 'node:path';

function requireSkills(ctx) {
  const skills = ctx.get('skills');
  if (skills === undefined) throw new Error('DSHX requires DSH service: skills');
  return skills;
}

function codexScope(source) {
  if (source === 'project-dsh' || source === 'project-agents') return 'repo';
  if (source === 'user-dsh' || source === 'user-agents') return 'user';
  return 'system';
}

/**
 * Project the subset of DSH skills that Codex's filesystem-oriented skill UI
 * can represent faithfully. DSH remains the complete skill registry; a remote
 * or runtime skill with no absolute file path is not fabricated into a path.
 */
export async function dshSkillsListEntry({ ctx, cwd, scope, diagnostics = () => {} }) {
  const absoluteCwd = path.resolve(cwd);
  const skills = requireSkills(ctx);
  const options = { cwd: absoluteCwd, ...(scope === undefined ? {} : { scope }) };
  const snapshot = await skills.snapshot(options);
  const data = [];
  const errors = [];

  if (snapshot.complete !== true) {
    errors.push({
      path: absoluteCwd,
      message: 'DSH skill discovery was incomplete; available candidates are shown without claiming the catalog is authoritative'
    });
  }

  for (const summary of snapshot.skills ?? []) {
    if (summary?.invocation?.userInvocable !== true) continue;
    try {
      const definition = await skills.get(summary.name, options);
      if (!definition) {
        errors.push({ path: summary.name, message: 'DSH skill disappeared before it could be loaded' });
        continue;
      }
      if (typeof definition.path !== 'string' || !path.isAbsolute(definition.path)) {
        // Codex SkillMetadata requires an absolute filesystem path. The DSH
        // registry explicitly permits provider-managed skills without one.
        diagnostics(`skill ${summary.name} is user-invocable but has no absolute filesystem path; omitted from Codex skill UI`);
        continue;
      }
      data.push({
        name: definition.name,
        description: definition.description,
        path: definition.path,
        scope: codexScope(definition.source),
        enabled: true
      });
    } catch (error) {
      errors.push({
        path: summary.name,
        message: error instanceof Error ? error.message : String(error)
      });
    }
  }

  return { cwd: absoluteCwd, skills: data, errors };
}

export const skillInternals = { codexScope };
