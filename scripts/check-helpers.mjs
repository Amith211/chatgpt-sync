import fs from "node:fs";

const source =
    fs.readFileSync(
        new URL(
            "../src/interceptor.js",
            import.meta.url
        ),
        "utf8"
    );

const requiredHelpers =
[
    "operationMatchesKnownStaleState",
    "createRecovery",
    "createAcceptedSend",
    "blockKnownStaleOperation",
    "findWritableAttachmentContext",
    "waitForAttachmentState",
    "getWritableContextRecoverableAttachments",
    "createReferenceOnlyBrowserFile",
    "toWritableContextAttachment",
    "getAttachmentStoreState",
    "appendAttachmentStoreState"
];

const missing =
    requiredHelpers.filter(
        name =>
        {
            const definition =
                new RegExp(
                    String.raw`\bfunction\s+${name}\s*\(`
                );

            const call =
                new RegExp(
                    String.raw`\b${name}\s*\(`
                );

            return (
                !definition.test(source) ||
                !call.test(source)
            );
        }
    );

if (missing.length > 0)
{
    console.error(
        "Missing required interceptor helper(s):",
        missing.join(", ")
    );

    process.exit(1);
}

if (
    source.includes(
        "return await allowOperation("
    )
)
{
    console.error(
        "Critical invariant failed: allowOperation must be returned without await."
    );

    process.exit(1);
}


if (
    !source.includes('kind: "writable-context"') ||
    !source.includes('typeof value.files$.set !== "function"') ||
    !source.includes('current => [') ||
    !source.includes('await waitForAttachmentState(') ||
    !source.includes('routeScope: routeScopeMatch?.routeScope ?? null') ||
    !source.includes('getWritableContextRecoverableAttachments(')
)
{
    console.error(
        "Attachment recovery invariant failed: writable-context restoration path is incomplete."
    );

    process.exit(1);
}

console.log(
    "Interceptor helper/invariant checks passed."
);


const contentSource =
    fs.readFileSync(
        new URL(
            "../src/content.js",
            import.meta.url
        ),
        "utf8"
    );

const requiredContentHelpers =
[
    "findComposer",
    "getComposerText",
    "restoreComposerText",
    "restoreComposerTextThroughVerifiedDomFallback",
    "waitForComposer"
];

const missingContentHelpers =
    requiredContentHelpers.filter(
        name =>
        {
            const definition =
                new RegExp(
                    String.raw`\b(?:async\s+)?function\s+${name}\s*\(`
                );

            return !definition.test(contentSource);
        }
    );

if (missingContentHelpers.length > 0)
{
    console.error(
        "Missing required content helper(s):",
        missingContentHelpers.join(", ")
    );

    process.exit(1);
}

if (
    contentSource.includes(
        "Recovery draft restored through DOM fallback."
    )
)
{
    console.error(
        "Recovery invariant failed: unverified DOM fallback success log remains."
    );

    process.exit(1);
}

if (
    !contentSource.includes(
        "Recovery draft restored through verified DOM fallback."
    )
)
{
    console.error(
        "Recovery invariant failed: verified DOM fallback success log is missing."
    );

    process.exit(1);
}

console.log(
    "Content recovery helper/invariant checks passed."
);
