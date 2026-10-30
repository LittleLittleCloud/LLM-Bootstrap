// JSON Schema validators for the two protocol schemas. Ajv is a dev dependency of this repository, so this
// returns null where it is not installed (an installed plugin, for example) and callers must say what was skipped.
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const SPECS = {
  experiment: ['experiment-protocol.openapi.json', 'https://llm-bootstrap.invalid/experiment-protocol'],
  evaluation: ['evaluation-protocol.openapi.json', 'https://llm-bootstrap.invalid/evaluation-protocol'],
};

// Returns { experiment: { Experiment: validate, ... }, evaluation: { EvaluationResult: validate, ... } } or null.
export async function loadValidators() {
  let Ajv2020;
  let addFormats;
  try {
    ({ default: Ajv2020 } = await import('ajv/dist/2020.js'));
    ({ default: addFormats } = await import('ajv-formats'));
  } catch {
    return null;
  }
  // Conditional overlays name sibling properties, so strictTypes and strictRequired stay off.
  const ajv = new Ajv2020({ allErrors: true, strict: true, strictTypes: false, strictRequired: false });
  addFormats(ajv);
  const validators = {};
  for (const [group, [file, id]] of Object.entries(SPECS)) {
    const document = JSON.parse(readFileSync(resolve(here, '../assets/schema', file), 'utf8'));
    // Component refs become $defs refs so each Schema Object compiles under strict JSON Schema 2020-12.
    const defs = JSON.parse(JSON.stringify(document.components.schemas).replaceAll('#/components/schemas/', () => '#/$defs/'));
    ajv.addSchema({ $id: id, $defs: defs });
    validators[group] = Object.fromEntries(Object.keys(defs).map(name => [name, ajv.compile({ $ref: `${id}#/$defs/${name}` })]));
  }
  return validators;
}

export const errorsOf = validate => (validate.errors ?? []).map(error => `${error.instancePath || '/'} ${error.message}`);
