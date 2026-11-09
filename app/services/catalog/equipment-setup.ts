import catalogJson from "../../data/equipment-catalog.json";

type AdminGraphql = {
  graphql: (
    query: string,
    options?: { variables?: Record<string, unknown> },
  ) => Promise<Response>;
};

type CatalogNode = {
  handle: string;
  title: string;
  thumbnail?: string;
  children?: CatalogNode[];
};

type Catalog = {
  hub_page_handle: string;
  namespace: string;
  top_categories: CatalogNode[];
  product_metafields: Array<{ key: string; name: string; type: string }>;
};

export type EquipmentSetupResult = {
  collectionsCreated: number;
  collectionsExisting: number;
  metafieldsCreated: number;
  metafieldsExisting: number;
  pageCreated: boolean;
  pageExisting: boolean;
  pageSkipped?: string;
  warnings: string[];
};

const catalog = catalogJson as Catalog;

function flatten(nodes: CatalogNode[], out: Array<{ handle: string; title: string }> = []) {
  for (const n of nodes) {
    out.push({ handle: n.handle, title: n.title });
    if (n.children?.length) flatten(n.children, out);
  }
  return out;
}

async function gql<T>(
  admin: AdminGraphql,
  query: string,
  variables?: Record<string, unknown>,
): Promise<T> {
  const res = await admin.graphql(query, { variables });
  const json = (await res.json()) as {
    data?: T;
    errors?: Array<{ message: string }>;
  };
  if (json.errors?.length) {
    throw new Error(json.errors.map((e) => e.message).join("; "));
  }
  if (!json.data) throw new Error("Empty GraphQL response");
  return json.data;
}

async function ensureCollection(
  admin: AdminGraphql,
  title: string,
  handle: string,
): Promise<"created" | "exists"> {
  const existing = await gql<{
    collections: { nodes: Array<{ id: string }> };
  }>(
    admin,
    `#graphql
    query FindCollection($q: String!) {
      collections(first: 1, query: $q) { nodes { id } }
    }`,
    { q: `handle:${handle}` },
  );
  if (existing.collections.nodes[0]) return "exists";

  const created = await gql<{
    collectionCreate: {
      collection?: { id: string };
      userErrors: Array<{ message: string }>;
    };
  }>(
    admin,
    `#graphql
    mutation CreateCollection($input: CollectionInput!) {
      collectionCreate(input: $input) {
        collection { id }
        userErrors { message }
      }
    }`,
    {
      input: {
        title,
        handle,
        descriptionHtml: `<p>${title} — HVAC Easy equipment category.</p>`,
      },
    },
  );
  const errs = created.collectionCreate.userErrors || [];
  if (errs.length) throw new Error(`${handle}: ${errs.map((e) => e.message).join("; ")}`);
  return "created";
}

async function ensureMetafield(
  admin: AdminGraphql,
  namespace: string,
  def: { key: string; name: string; type: string },
): Promise<"created" | "exists"> {
  const existing = await gql<{
    metafieldDefinitions: { nodes: Array<{ id: string }> };
  }>(
    admin,
    `#graphql
    query FindDef($ownerType: MetafieldOwnerType!, $namespace: String!, $key: String!) {
      metafieldDefinitions(first: 1, ownerType: $ownerType, namespace: $namespace, key: $key) {
        nodes { id }
      }
    }`,
    { ownerType: "PRODUCT", namespace, key: def.key },
  );
  if (existing.metafieldDefinitions.nodes[0]) return "exists";

  const created = await gql<{
    metafieldDefinitionCreate: {
      createdDefinition?: { id: string };
      userErrors: Array<{ message: string }>;
    };
  }>(
    admin,
    `#graphql
    mutation CreateDef($definition: MetafieldDefinitionInput!) {
      metafieldDefinitionCreate(definition: $definition) {
        createdDefinition { id }
        userErrors { message }
      }
    }`,
    {
      definition: {
        name: def.name,
        namespace,
        key: def.key,
        type: def.type || "single_line_text_field",
        ownerType: "PRODUCT",
        description: `${def.name} filter for HVAC Equipment catalog`,
        pin: true,
        access: { storefront: "PUBLIC_READ" },
      },
    },
  );
  const errs = created.metafieldDefinitionCreate.userErrors || [];
  if (errs.length) {
    const msg = errs.map((e) => e.message).join("; ");
    if (/taken|already|exists/i.test(msg)) return "exists";
    throw new Error(`${def.key}: ${msg}`);
  }
  return "created";
}

async function ensureEquipmentPage(
  admin: AdminGraphql,
  handle: string,
): Promise<"created" | "exists" | "skipped"> {
  try {
    const existing = await gql<{
      pages: { nodes: Array<{ id: string }> };
    }>(
      admin,
      `#graphql
      query FindPage($q: String!) {
        pages(first: 1, query: $q) { nodes { id } }
      }`,
      { q: `handle:${handle}` },
    );
    if (existing.pages.nodes[0]) return "exists";

    const created = await gql<{
      pageCreate: {
        page?: { id: string };
        userErrors: Array<{ message: string }>;
      };
    }>(
      admin,
      `#graphql
      mutation CreatePage($page: PageCreateInput!) {
        pageCreate(page: $page) {
          page { id }
          userErrors { message }
        }
      }`,
      {
        page: {
          title: "Equipment",
          handle,
          body: "<p>Browse HVAC equipment by category.</p>",
          isPublished: true,
          templateSuffix: "equipment",
        },
      },
    );
    const errs = created.pageCreate.userErrors || [];
    if (errs.length) {
      const msg = errs.map((e) => e.message).join("; ");
      if (/access|scope|denied|unauthorized/i.test(msg)) return "skipped";
      throw new Error(msg);
    }
    return "created";
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/access|scope|denied|unauthorized|ACCESS/i.test(msg)) return "skipped";
    throw err;
  }
}

/**
 * Idempotent Equipment catalog bootstrap using the shop's Admin API session.
 */
export async function setupEquipmentCatalog(
  admin: AdminGraphql,
): Promise<EquipmentSetupResult> {
  const warnings: string[] = [];
  let collectionsCreated = 0;
  let collectionsExisting = 0;
  let metafieldsCreated = 0;
  let metafieldsExisting = 0;

  const pageStatus = await ensureEquipmentPage(admin, catalog.hub_page_handle);
  let pageCreated = pageStatus === "created";
  let pageExisting = pageStatus === "exists";
  let pageSkipped: string | undefined;
  if (pageStatus === "skipped") {
    pageSkipped =
      "Page create needs write_content / online store pages scope. Create /pages/equipment manually or reinstall after scope update.";
    warnings.push(pageSkipped);
  }

  for (const def of catalog.product_metafields) {
    const status = await ensureMetafield(admin, catalog.namespace, def);
    if (status === "created") metafieldsCreated += 1;
    else metafieldsExisting += 1;
  }

  for (const item of flatten(catalog.top_categories)) {
    const status = await ensureCollection(admin, item.title, item.handle);
    if (status === "created") collectionsCreated += 1;
    else collectionsExisting += 1;
  }

  return {
    collectionsCreated,
    collectionsExisting,
    metafieldsCreated,
    metafieldsExisting,
    pageCreated,
    pageExisting,
    pageSkipped,
    warnings,
  };
}

export function equipmentCatalogSummary() {
  const collections = flatten(catalog.top_categories);
  return {
    collectionCount: collections.length,
    metafieldCount: catalog.product_metafields.length,
    namespace: catalog.namespace,
    hubPageHandle: catalog.hub_page_handle,
    topCategoryCount: catalog.top_categories.length,
  };
}
