import { WallosConfigError } from '../errors.js';
import type { WallosClient } from '../wallos-client.js';

export interface NamedEntity {
  id: number;
  name: string;
  [key: string]: unknown;
}

export interface MasterData {
  categories: NamedEntity[];
  currencies: NamedEntity[];
  paymentMethods: NamedEntity[];
  household: NamedEntity[];
  mainCurrencyId: number | null;
}

export interface EntityRef {
  id?: number | undefined;
  name?: string | undefined;
}

export type EntityKind = 'category' | 'currency' | 'payment_method' | 'household';

interface EntitySpec {
  label: string;
  list: (data: MasterData) => NamedEntity[];
  /** Extra keys a name can match on, e.g. a currency code. */
  aliases: (entity: NamedEntity) => string[];
  create: ((client: WallosClient, name: string) => Promise<number>) | null;
  creatableHint: string;
}

const SPECS: Record<EntityKind, EntitySpec> = {
  category: {
    label: 'category',
    list: (data) => data.categories,
    aliases: () => [],
    create: async (client, name) => {
      const response = await client.write<Record<string, unknown>>('api/categories/set_categories.php', {
        action: 'add',
        name,
      });
      return Number(response.categoryId);
    },
    creatableHint: 'Categories can be created by name.',
  },
  currency: {
    label: 'currency',
    list: (data) => data.currencies,
    aliases: (entity) => (typeof entity.code === 'string' ? [entity.code] : []),
    // A currency needs a symbol and an ISO code, so guessing one from a bare
    // name would produce a wrong-looking entry in the user's Wallos.
    create: null,
    creatableHint: 'A currency needs a name, symbol and code, so create it in Wallos rather than by name.',
  },
  payment_method: {
    label: 'payment method',
    list: (data) => data.paymentMethods,
    aliases: () => [],
    create: async (client, name) => {
      const response = await client.write<Record<string, unknown>>('api/payment_methods/set_payment_methods.php', {
        action: 'add',
        name,
      });
      return Number(response.paymentId);
    },
    creatableHint: 'Payment methods can be created by name.',
  },
  household: {
    label: 'household member',
    list: (data) => data.household,
    aliases: () => [],
    create: async (client, name) => {
      const response = await client.write<Record<string, unknown>>('api/household/set_household.php', {
        action: 'add',
        name,
      });
      return Number(response.memberId);
    },
    creatableHint: 'Household members can be created by name.',
  },
};

function entitiesFrom(payload: unknown): NamedEntity[] {
  if (!Array.isArray(payload)) return [];
  return payload
    .filter((entry): entry is Record<string, unknown> => entry !== null && typeof entry === 'object')
    .map((entry) => ({
      ...entry,
      id: Number(entry.id),
      name: typeof entry.name === 'string' ? entry.name : '',
    }))
    .filter((entry) => Number.isFinite(entry.id));
}

export async function loadMasterData(client: WallosClient): Promise<MasterData> {
  const [categories, currencies, paymentMethods, household] = await Promise.all([
    client.read<Record<string, unknown>>('api/categories/get_categories.php'),
    client.read<Record<string, unknown>>('api/currencies/get_currencies.php'),
    client.read<Record<string, unknown>>('api/payment_methods/get_payment_methods.php'),
    client.read<Record<string, unknown>>('api/household/get_household.php'),
  ]);

  const mainCurrency = currencies.main_currency;

  return {
    categories: entitiesFrom(categories.categories),
    currencies: entitiesFrom(currencies.currencies),
    paymentMethods: entitiesFrom(paymentMethods.payment_methods),
    household: entitiesFrom(household.household),
    mainCurrencyId: mainCurrency === undefined || mainCurrency === null ? null : Number(mainCurrency),
  };
}

/** Case-insensitive, whitespace-tolerant, and aware of currency codes. */
export function matchEntity(spec: EntitySpec, entities: NamedEntity[], name: string): NamedEntity | undefined {
  const wanted = name.trim().toLowerCase();
  if (wanted === '') return undefined;

  return entities.find((entity) => {
    const candidates = [entity.name, ...spec.aliases(entity)];
    return candidates.some((candidate) => candidate.trim().toLowerCase() === wanted);
  });
}

function describeOptions(spec: EntitySpec, entities: NamedEntity[]): string {
  if (entities.length === 0) {
    return `There are no ${spec.label} entries in this Wallos instance yet.`;
  }
  const names = entities
    .map((entity) => {
      const aliases = spec.aliases(entity);
      return aliases.length > 0 ? `${entity.name} (${aliases.join('/')})` : entity.name;
    })
    .join(', ');
  return `Existing ${spec.label} entries: ${names}.`;
}

export interface ResolveOptions {
  client: WallosClient;
  data: MasterData;
  kind: EntityKind;
  ref: EntityRef;
  createIfMissing: boolean;
}

/**
 * Turns either an id or a name into the integer id Wallos stores.
 *
 * A model reading "add Netflix, category Entertainment" has a name, not an id,
 * so names are matched against the instance's own lists; `createIfMissing`
 * mirrors what the Wallos UI does when you type a new category.
 */
export async function resolveEntityId(options: ResolveOptions): Promise<number | undefined> {
  const { client, data, kind, ref, createIfMissing } = options;
  const spec = SPECS[kind];

  if (ref.id !== undefined) {
    return ref.id;
  }

  const name = ref.name?.trim();
  if (name === undefined || name === '') {
    return undefined;
  }

  const entities = spec.list(data);
  const match = matchEntity(spec, entities, name);
  if (match !== undefined) {
    return match.id;
  }

  if (!createIfMissing || spec.create === null) {
    const reason = createIfMissing ? ` ${spec.creatableHint}` : ' Pass create_missing: true to create it.';
    throw new WallosConfigError(
      `No ${spec.label} named "${name}" exists in this Wallos instance.${reason} ${describeOptions(spec, entities)}`,
    );
  }

  const created = await spec.create(client, name);
  if (!Number.isFinite(created)) {
    throw new WallosConfigError(`Wallos did not return an id for the new ${spec.label} "${name}".`);
  }

  // Keep the snapshot honest so a second reference in the same call resolves
  // to the entry that was just created.
  entities.push({ id: created, name });

  return created;
}
