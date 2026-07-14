// Parse a line the owner typed into a command or a task. A leading '/' marks a
// command; anything else is a task. Pure + unit-tested.

export type Command =
  | { kind: 'task'; text: string }
  | { kind: 'status' }
  | { kind: 'model'; model?: string }
  | { kind: 'cancel'; target?: string }
  | { kind: 'new' }
  | { kind: 'project'; name?: string }
  | { kind: 'queue'; text: string }
  | { kind: 'help' }
  | { kind: 'unknown'; name: string }

export function parseCommand(input: string): Command {
  const text = input.trim()
  if (!text.startsWith('/')) return { kind: 'task', text }
  const sp = text.search(/\s/)
  const name = (sp === -1 ? text : text.slice(0, sp)).slice(1).toLowerCase()
  const arg = sp === -1 ? '' : text.slice(sp + 1).trim()
  switch (name) {
    case 'status':
      return { kind: 'status' }
    case 'model':
      return arg ? { kind: 'model', model: arg } : { kind: 'model' }
    case 'cancel':
    case 'stop':
      return arg ? { kind: 'cancel', target: arg } : { kind: 'cancel' }
    case 'new':
    case 'reset':
      return { kind: 'new' }
    case 'project':
    case 'cd':
      return arg ? { kind: 'project', name: arg } : { kind: 'project' }
    case 'queue':
    case 'q':
      return arg ? { kind: 'queue', text: arg } : { kind: 'help' }
    case 'help':
    case '?':
      return { kind: 'help' }
    default:
      return { kind: 'unknown', name }
  }
}

export const HELP_TEXT = [
  'Commands:',
  '/status — model, queue, what I’m doing',
  '/model [name] — list or switch model',
  '/cancel [id|all] — stop the running task (or all)',
  '/new — start a fresh session (forget context)',
  '/project [name] — list or switch project',
  '/queue <task> — queue a task while I’m waiting on you',
  'Anything without a leading / is a task.',
].join('\n')
