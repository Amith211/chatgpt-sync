(() =>
{
    const originalFetch =
        window.fetch;

    const MESSAGE_SOURCE =
        "chatgpt-sync";

    const RECOVERY_LOCK_ATTRIBUTE =
        "data-chatgpt-sync-recovery-lock";


    function getUserMessage(
        body
    )
    {
        if (
            !Array.isArray(
                body?.messages
            )
        )
        {
            return null;
        }


        for (
            let i =
                body.messages.length - 1;

            i >= 0;

            i--
        )
        {
            const message =
                body.messages[i];


            if (
                message?.author?.role !==
                "user"
            )
            {
                continue;
            }


            return message;
        }


        return null;
    }


    function getMessageText(
        message
    )
    {
        const parts =
            message?.content?.parts;


        if (
            !Array.isArray(
                parts
            )
        )
        {
            return null;
        }


        const textParts =
            parts.filter(
                part =>
                    typeof part ===
                    "string"
            );


        if (
            textParts.length ===
            0
        )
        {
            return null;
        }


        return textParts.join(
            ""
        );
    }


    function getMessageId(
        message
    )
    {
        if (
            typeof message?.id !==
            "string"
        )
        {
            return null;
        }


        return message.id;
    }


    function cloneMessage(
        message
    )
    {
        if (!message)
        {
            return null;
        }


        try
        {
            return structuredClone(
                message
            );
        }
        catch
        {
            try
            {
                return JSON.parse(
                    JSON.stringify(
                        message
                    )
                );
            }
            catch
            {
                return null;
            }
        }
    }


    function notifyExtension(
        type,
        payload
    )
    {
        window.postMessage(
            {
                source:
                    MESSAGE_SOURCE,

                type,

                ...payload
            },
            window.location.origin
        );
    }


    window.__chatgptSync =
    {
        lastBlockedMessage:
            null,

        knownStale:
            null
    };


    function operationMatchesKnownStaleState(
        conversationId,
        parentMessageId
    )
    {
        const knownStale =
            window.__chatgptSync
                .knownStale;


        if (!knownStale)
        {
            return false;
        }


        return (
            knownStale.conversationId ===
                conversationId &&

            knownStale.localParentMessageId ===
                parentMessageId
        );
    }


    function createRecovery(
        conversationId,
        parentMessageId,
        serverCurrentNode,
        userMessage,
        messageText
    )
    {
        return {
            conversationId,

            localParentMessageId:
                parentMessageId,

            serverCurrentNode,

            text:
                messageText,

            messageId:
                getMessageId(
                    userMessage
                ),

            message:
                cloneMessage(
                    userMessage
                ),

            blockedAt:
                new Date()
                    .toISOString()
        };
    }


    function createAcceptedSend(
        conversationId,
        parentMessageId,
        userMessage,
        messageText,
        response
    )
    {
        return {
            conversationId,

            parentMessageId,

            text:
                messageText,

            messageId:
                getMessageId(
                    userMessage
                ),

            message:
                cloneMessage(
                    userMessage
                ),

            status:
                response.status,

            acceptedAt:
                new Date()
                    .toISOString()
        };
    }


    function blockKnownStaleOperation(
        conversationId,
        parentMessageId,
        userMessage,
        messageText
    )
    {
        const knownStale =
            window.__chatgptSync
                .knownStale;


        if (!userMessage)
        {
            console.log(
                "[ChatGPT Sync] BLOCKED - " +
                "known-stale background operation. " +
                "No additional state GET required.",
                {
                    localParentMessageId:
                        parentMessageId,

                    serverCurrentNode:
                        knownStale.serverCurrentNode,

                    hasUserMessage:
                        false
                }
            );


            notifyExtension(
                "stale-detected",
                {
                    staleState:
                        knownStale
                }
            );


            return Promise.reject(
                new Error(
                    "ChatGPT Sync blocked a known-stale " +
                    "background conversation operation."
                )
            );
        }


        const recovery =
            createRecovery(
                conversationId,
                parentMessageId,
                knownStale.serverCurrentNode,
                userMessage,
                messageText
            );


        window.__chatgptSync
            .lastBlockedMessage =
            recovery;


        console.log(
            "[ChatGPT Sync] BLOCKED - " +
                "known-stale user send. " +
                "No additional state GET required.",
            {
                localParentMessageId:
                    parentMessageId,

                serverCurrentNode:
                    knownStale.serverCurrentNode,

                blockedMessageText:
                    messageText,

                messageId:
                    recovery.messageId
            }
        );


        notifyExtension(
            "stale-send-blocked",
            {
                recovery
            }
        );


        return Promise.reject(
            new Error(
                "ChatGPT Sync blocked this message because " +
                "the conversation is out of sync."
            )
        );
    }


    const USER_STATE_CHECK_MAX_DURATION_MS =
        5 * 60 * 1000;

    const USER_STATE_CHECK_EARLY_PHASE_MS =
        30000;

    const USER_STATE_CHECK_BACKOFF_MS =
        [
            2000,
            5000,
            10000,
            10000,
            20000,
            40000,
            60000
        ];


    function sleep(
        delayMs
    )
    {
        return new Promise(
            resolve =>
            {
                setTimeout(
                    resolve,
                    delayMs
                );
            }
        );
    }


    function getRetryAfterMs(
        response
    )
    {
        const value =
            response?.headers?.get(
                "retry-after"
            );

        if (!value)
        {
            return null;
        }


        const seconds =
            Number(
                value
            );

        if (
            Number.isFinite(
                seconds
            ) &&
            seconds >= 0
        )
        {
            return Math.ceil(
                seconds * 1000
            );
        }


        const retryAt =
            Date.parse(
                value
            );

        if (
            Number.isNaN(
                retryAt
            )
        )
        {
            return null;
        }


        return Math.max(
            retryAt - Date.now(),
            0
        );
    }


    function getStateRetryDelayMs(
        elapsedMs,
        retryIndex,
        latestRetryAfterMs
    )
    {
        const scheduledDelayMs =
            USER_STATE_CHECK_BACKOFF_MS[
                Math.min(
                    retryIndex,
                    USER_STATE_CHECK_BACKOFF_MS.length - 1
                )
            ];

        if (latestRetryAfterMs === null)
        {
            return scheduledDelayMs;
        }

        if (elapsedMs < USER_STATE_CHECK_EARLY_PHASE_MS)
        {
            return Math.min(
                scheduledDelayMs,
                latestRetryAfterMs
            );
        }

        return latestRetryAfterMs;
    }


    async function requestAuthoritativeState(
        stateUrl,
        authorization
    )
    {
        return originalFetch.call(
            window,
            stateUrl,
            {
                method:
                    "GET",

                credentials:
                    "include",

                cache:
                    "no-store",

                headers:
                {
                    "authorization":
                        authorization
                }
            }
        );
    }


    async function verifyUserSendState(
        stateUrl,
        authorization,
        conversationId,
        userMessage,
        messageText
    )
    {
        const startedAt =
            Date.now();

        const deadlineAt =
            startedAt +
            USER_STATE_CHECK_MAX_DURATION_MS;

        let attempt =
            0;

        let retryIndex =
            0;

        let lastFailure =
            null;

        let latestRetryAfterMs =
            null;

        while (Date.now() < deadlineAt)
        {
            attempt++;

            let response =
                null;

            let error =
                null;

            try
            {
                response =
                    await requestAuthoritativeState(
                        stateUrl,
                        authorization
                    );
            }
            catch (caughtError)
            {
                error =
                    caughtError;
            }

            if (response?.ok)
            {
                try
                {
                    const serverState =
                        await response.json();

                    if (serverState?.current_node)
                    {
                        notifyExtension(
                            "state-verification-resolved",
                            {
                                conversationId
                            }
                        );

                        return {
                            ok:
                                true,
                            serverState
                        };
                    }

                    lastFailure =
                    {
                        kind:
                            "missing-current-node",
                        status:
                            response.status,
                        statusText:
                            response.statusText,
                        retryAfterMs:
                            null
                    };
                }
                catch (parseError)
                {
                    lastFailure =
                    {
                        kind:
                            "parse-error",
                        error:
                            String(parseError),
                        retryAfterMs:
                            null
                    };
                }
            }
            else if (response)
            {
                const responseRetryAfterMs =
                    response.status === 429
                        ? getRetryAfterMs(response)
                        : null;

                if (
                    response.status === 429 &&
                    responseRetryAfterMs !== null
                )
                {
                    latestRetryAfterMs =
                        responseRetryAfterMs;
                }
                else if (response.status !== 429)
                {
                    latestRetryAfterMs =
                        null;
                }

                lastFailure =
                {
                    kind:
                        "http-error",
                    status:
                        response.status,
                    statusText:
                        response.statusText,
                    retryAfterMs:
                        responseRetryAfterMs
                };
            }
            else
            {
                lastFailure =
                {
                    kind:
                        "network-error",
                    error:
                        String(error),
                    retryAfterMs:
                        null
                };

                latestRetryAfterMs =
                    null;
            }

            const now =
                Date.now();

            const elapsedMs =
                now - startedAt;

            const remainingMs =
                deadlineAt - now;

            console.error(
                "[ChatGPT Sync] User-send state verification attempt failed.",
                {
                    attempt,
                    elapsedMs,
                    remainingMs,
                    failure:
                        lastFailure,
                    latestRetryAfterMs
                }
            );

            if (remainingMs <= 0)
            {
                break;
            }

            const delayMs =
                getStateRetryDelayMs(
                    elapsedMs,
                    retryIndex,
                    latestRetryAfterMs
                );

            if (
                elapsedMs >= USER_STATE_CHECK_EARLY_PHASE_MS &&
                latestRetryAfterMs !== null &&
                delayMs > remainingMs
            )
            {
                break;
            }

            const boundedDelayMs =
                Math.min(
                    delayMs,
                    remainingMs
                );

            notifyExtension(
                "state-verification-waiting",
                {
                    conversationId,
                    attempt,
                    elapsedMs,
                    maxDurationMs:
                        USER_STATE_CHECK_MAX_DURATION_MS,
                    delayMs:
                        boundedDelayMs,
                    retryAt:
                        new Date(
                            now + boundedDelayMs
                        ).toISOString()
                }
            );

            await sleep(
                boundedDelayMs
            );

            retryIndex++;
        }

        const finalRetryDelayMs =
            latestRetryAfterMs ??
            USER_STATE_CHECK_BACKOFF_MS[
                USER_STATE_CHECK_BACKOFF_MS.length - 1
            ];

        notifyExtension(
            "state-verification-failed",
            {
                conversationId,
                failure:
                    lastFailure,
                retryAfterMs:
                    finalRetryDelayMs,
                retryAt:
                    new Date(
                        Date.now() + finalRetryDelayMs
                    ).toISOString(),
                messageText:
                    messageText ?? "",
                message:
                    cloneMessage(userMessage)
            }
        );

        return {
            ok:
                false,
            failure:
                lastFailure
        };
    }


    async function allowOperation(
        fetchThis,
        args,
        conversationId,
        parentMessageId,
        userMessage,
        messageText
    )
    {
        const response =
            await originalFetch.apply(
                fetchThis,
                args
            );


        /*
         * Background operations do not participate in
         * recovery cleanup.
         */
        if (!userMessage)
        {
            return response;
        }


        if (!response.ok)
        {
            /*
             * The request was deliberately allowed because
             * state was healthy, but the server then rejected
             * it. That is genuinely noteworthy.
             */
            console.warn(
                "[ChatGPT Sync] User send reached the server " +
                "but was not accepted successfully.",
                {
                    conversationId,

                    parentMessageId,

                    status:
                        response.status,

                    statusText:
                        response.statusText,

                    messageId:
                        getMessageId(
                            userMessage
                        ),

                    text:
                        messageText
                }
            );


            return response;
        }


        const acceptedSend =
            createAcceptedSend(
                conversationId,
                parentMessageId,
                userMessage,
                messageText,
                response
            );


        console.log(
            "[ChatGPT Sync] User send accepted by server.",
            {
                conversationId,

                parentMessageId,

                status:
                    response.status,

                messageId:
                    acceptedSend.messageId,

                text:
                    messageText
            }
        );


        notifyExtension(
            "send-accepted",
            {
                acceptedSend
            }
        );


        return response;
    }


    function getConversationIdFromLocation()
    {
        return window.location.pathname.match(
            /^\/c\/([^/?#]+)/
        )?.[1] ?? null;
    }


    function findComposerForm()
    {
        const composer =
            document.querySelector(
                '.ProseMirror[contenteditable="true"][role="textbox"]'
            ) ??

            document.querySelector(
                "#prompt-textarea"
            ) ??

            document.querySelector(
                '[contenteditable="true"][role="textbox"][aria-label="Ask ChatGPT"]'
            ) ??

            document.querySelector(
                '[contenteditable="true"][role="textbox"]'
            );


        const containingForm =
            composer?.closest(
                "form"
            );


        return (
            containingForm ??
            document.querySelector(
                "form[data-chatgpt-composer]"
            )
        );
    }


    function findRouteScopeInObject(
        root,
        conversationId,
        maxDepth = 4
    )
    {
        const seen = new WeakSet();

        function visit(value, depth, path)
        {
            if (
                !value ||
                (
                    typeof value !== "object" &&
                    typeof value !== "function"
                )
            )
            {
                return null;
            }

            if (
                value === window ||
                value === document ||
                value instanceof Node ||
                seen.has(value)
            )
            {
                return null;
            }

            seen.add(value);

            try
            {
                if (
                    value.scope?.__scopeBrand === "RouteScope" &&
                    value.value?.conversationId === conversationId &&
                    typeof value.get === "function" &&
                    typeof value.set === "function" &&
                    value.node
                )
                {
                    return {
                        routeScope: value,
                        path
                    };
                }
            }
            catch
            {
            }

            if (depth >= maxDepth)
            {
                return null;
            }

            let keys;

            try
            {
                keys = Reflect.ownKeys(value);
            }
            catch
            {
                return null;
            }

            for (const key of keys)
            {
                const keyText = String(key);

                if (
                    keyText === "return" ||
                    keyText === "child" ||
                    keyText === "sibling" ||
                    keyText === "stateNode" ||
                    keyText.startsWith("__react")
                )
                {
                    continue;
                }

                let child;

                try
                {
                    child = value[key];
                }
                catch
                {
                    continue;
                }

                const result = visit(
                    child,
                    depth + 1,
                    `${path}.${keyText}`
                );

                if (result)
                {
                    return result;
                }
            }

            return null;
        }

        return visit(root, 0, "root");
    }


    function waitForComposerForm(
        timeoutMilliseconds = 15000
    )
    {
        return new Promise(resolve =>
        {
            const existing =
                findComposerForm();

            if (existing)
            {
                resolve(existing);
                return;
            }

            let settled = false;

            const finish =
                composer =>
                {
                    if (settled)
                    {
                        return;
                    }

                    settled = true;
                    observer.disconnect();
                    clearTimeout(timeout);
                    resolve(composer);
                };

            const observer =
                new MutationObserver(() =>
                {
                    const composer =
                        findComposerForm();

                    if (composer)
                    {
                        finish(composer);
                    }
                });

            observer.observe(
                document.documentElement,
                {
                    childList: true,
                    subtree: true
                }
            );

            const timeout =
                setTimeout(
                    () => finish(null),
                    timeoutMilliseconds
                );

            const composer =
                findComposerForm();

            if (composer)
            {
                finish(composer);
            }
        });
    }


    function getReactFiberFromElement(
        element
    )
    {
        if (!element)
        {
            return null;
        }

        const fiberKey = Reflect.ownKeys(element).find(
            key =>
                typeof key === "string" &&
                key.startsWith("__reactFiber$")
        );

        return fiberKey
            ? element[fiberKey]
            : null;
    }


    function findWritableAttachmentContext(
        startFiber
    )
    {
        const matches = [];
        const seen = new Set();

        for (
            let fiber = startFiber, fiberDepth = 0;
            fiber && fiberDepth < 100;
            fiberDepth++, fiber = fiber.return
        )
        {
            let dependency = fiber.dependencies?.firstContext;

            for (
                let contextIndex = 0;
                dependency && contextIndex < 200;
                contextIndex++, dependency = dependency.next
            )
            {
                const value = dependency.memoizedValue;

                if (
                    !value ||
                    typeof value !== "object" ||
                    typeof value.files$ !== "function" ||
                    typeof value.files$.set !== "function" ||
                    typeof value.readyFiles$ !== "function" ||
                    typeof value.hasUploadInProgress$ !== "function" ||
                    seen.has(value)
                )
                {
                    continue;
                }

                let files;

                try
                {
                    files = value.files$();
                }
                catch
                {
                    continue;
                }

                if (!Array.isArray(files))
                {
                    continue;
                }

                seen.add(value);
                matches.push({
                    context: value,
                    files,
                    fiberDepth,
                    contextIndex
                });
            }
        }

        if (matches.length === 0)
        {
            return null;
        }

        /*
         * The same context can be consumed more than once in the composer
         * tree. Deduplication above is by context value identity, so more
         * than one remaining match is genuinely ambiguous.
         */
        if (matches.length !== 1)
        {
            return {
                ambiguous: true,
                count: matches.length
            };
        }

        return matches[0];
    }


    function discoverAttachmentState(
        conversationId
    )
    {
        const composer = findComposerForm();

        if (!composer)
        {
            return {
                success: false,
                error: "Composer form not found."
            };
        }

        const fiberKey = Reflect.ownKeys(composer).find(
            key =>
                typeof key === "string" &&
                key.startsWith("__reactFiber$")
        );

        if (!fiberKey)
        {
            return {
                success: false,
                error: "React Fiber not found."
            };
        }

        let fiber = composer[fiberKey];
        let routeScopeMatch = null;
        let removeCallback = null;
        const writableAttachmentContext =
            findWritableAttachmentContext(
                composer[fiberKey]
            );

        for (
            let fiberDepth = 0;
            fiber && fiberDepth < 100;
            fiberDepth++, fiber = fiber.return
        )
        {
            for (const property of [
                "memoizedState",
                "memoizedProps",
                "pendingProps"
            ])
            {
                if (!routeScopeMatch && fiber[property])
                {
                    const match = findRouteScopeInObject(
                        fiber[property],
                        conversationId
                    );

                    if (match)
                    {
                        routeScopeMatch = match;
                    }
                }
            }

            for (const property of [
                "memoizedProps",
                "pendingProps"
            ])
            {
                const props = fiber[property];

                if (
                    !removeCallback &&
                    typeof props?.onAttachmentRemove === "function"
                )
                {
                    removeCallback = props.onAttachmentRemove;
                }
            }

            if (routeScopeMatch && removeCallback)
            {
                break;
            }
        }

        /*
         * Firefox Android currently exposes the composer attachment state
         * through a React context rather than the desktop onAttachmentRemove
         * discovery path. This path deliberately does not require RouteScope:
         * Test 900 proved the writable context is sufficient to restore and
         * submit a persisted server-side attachment reference on Android.
         */
        if (!removeCallback)
        {
            if (writableAttachmentContext?.ambiguous)
            {
                return {
                    success: false,
                    error: "Writable attachment context discovery was ambiguous."
                };
            }

            if (writableAttachmentContext?.context)
            {
                return {
                    success: true,
                    routeScope: routeScopeMatch?.routeScope ?? null,
                    attachmentStore: {
                        kind: "writable-context",
                        context: writableAttachmentContext.context,
                        fiberDepth: writableAttachmentContext.fiberDepth,
                        contextIndex: writableAttachmentContext.contextIndex
                    },
                    currentAttachments: writableAttachmentContext.files
                };
            }

            return {
                success: false,
                error: "Attachment React state could not be located."
            };
        }

        if (!routeScopeMatch)
        {
            return {
                success: false,
                error: "Attachment React state could not be located."
            };
        }

        const routeScope = routeScopeMatch.routeScope;
        const appNode = routeScope.node?.parent?.parent;

        if (
            !appNode?.familyBindings ||
            typeof appNode.familyBindings.entries !== "function"
        )
        {
            return {
                success: false,
                error: "AppScope bindings not found."
            };
        }

        /*
         * If attachments already exist, identify their family by the
         * stable attachment shape. This also prevents duplicate restore.
         */
        const populated = [];
        const empty = [];

        for (const [family, bindings] of appNode.familyBindings.entries())
        {
            try
            {
                if (
                    family?.kind !== "signal-family" ||
                    family?.scope?.__scopeBrand !== "AppScope" ||
                    !bindings?.has(conversationId)
                )
                {
                    continue;
                }

                const value = routeScope.get(
                    family,
                    conversationId
                );

                const binding = bindings.get(conversationId);
                const atom = binding?.value?.atom;

                if (!Array.isArray(value))
                {
                    continue;
                }

                if (
                    value.length > 0 &&
                    value.every(item =>
                        item &&
                        typeof item === "object" &&
                        typeof item.uploadId === "string" &&
                        typeof item.status === "string" &&
                        typeof item.id === "string"
                    )
                )
                {
                    populated.push({ family, value });
                }
                else if (
                    value.length === 0 &&
                    atom &&
                    typeof atom.write === "function"
                )
                {
                    empty.push({
                        family,
                        atom,
                        originalWrite: atom.write,
                        events: 0
                    });
                }
            }
            catch
            {
            }
        }

        if (populated.length === 1)
        {
            return {
                success: true,
                routeScope,
                attachmentStore: {
                    kind: "route-scope",
                    attachmentFamily: populated[0].family
                },
                attachmentFamily: populated[0].family,
                currentAttachments: populated[0].value
            };
        }

        if (populated.length > 1)
        {
            return {
                success: false,
                error: "Attachment state discovery was ambiguous."
            };
        }

        if (empty.length === 0)
        {
            return {
                success: false,
                error: "No empty attachment-state candidates found."
            };
        }

        let callbackError = null;

        try
        {
            for (const candidate of empty)
            {
                candidate.atom.write = function (...args)
                {
                    candidate.events++;

                    return candidate.originalWrite.apply(
                        this,
                        args
                    );
                };
            }

            removeCallback(
                "__chatgpt_sync_probe_" + crypto.randomUUID(),
                "system"
            );
        }
        catch (error)
        {
            callbackError = error;
        }
        finally
        {
            for (const candidate of empty)
            {
                candidate.atom.write = candidate.originalWrite;
            }
        }

        if (callbackError)
        {
            return {
                success: false,
                error: "Attachment discovery probe failed."
            };
        }

        const touched = empty.filter(
            candidate => candidate.events > 0
        );

        if (touched.length !== 1)
        {
            return {
                success: false,
                error: "Attachment discovery probe was ambiguous."
            };
        }

        return {
            success: true,
            routeScope,
            attachmentStore: {
                kind: "route-scope",
                attachmentFamily: touched[0].family
            },
            attachmentFamily: touched[0].family,
            currentAttachments: routeScope.get(
                touched[0].family,
                conversationId
            )
        };
    }


    function getFileExtension(
        name
    )
    {
        if (typeof name !== "string")
        {
            return "";
        }

        const index = name.lastIndexOf(".");

        if (index <= 0 || index === name.length - 1)
        {
            return "";
        }

        return name.slice(index + 1).toLowerCase();
    }


    /*
     * ChatGPT's filename MIME overrides, reproduced from the
     * current client classifier that we reverse-engineered.
     *
     * These matter because outgoing attachment metadata can be
     * less specific than the MIME used by uploadRouting. For
     * example, a .cs recovery is stored as text/plain but the
     * live attachment route is text/x-csharp.
     */
    const FILE_NAME_MIME_OVERRIDES =
        new Map([
            ["md", "text/markdown"],
            ["java", "text/x-java"],
            ["py", "text/x-script.python"],
            ["c", "text/x-c"],
            ["cpp", "text/x-c++"],
            ["h", "text/x-c++"],
            ["php", "text/x-php"],
            ["rb", "text/x-ruby"],
            ["tex", "application/x-latext"],
            ["ts", "text/x-typescript"],
            ["cs", "text/x-csharp"],
            ["go", "text/x-go"],
            ["rs", "text/x-rust"],
            ["scala", "application/x-scala"],
            ["kt", "text/x-kotlin"],
            ["swift", "text/x-swift"],
            ["lua", "text/x-lua"],
            ["r", "text/x-r"],
            ["jl", "text/x-julia"],
            ["pl", "text/x-perl"],
            ["sh", "text/x-shellscript"],
            ["bash", "text/x-shellscript"],
            ["m", "text/x-objectivec"],
            ["mm", "text/x-objectivec++"],
            ["erl", "text/x-erlang"],
            ["ex", "text/x-elixir"],
            ["exs", "text/x-elixir"],
            ["hs", "text/x-haskell"],
            ["clj", "text/x-clojure"],
            ["groovy", "text/x-groovy"],
            ["dart", "text/x-dart"],
            ["jsx", "text/jsx"],
            ["tsx", "text/tsx"],
            ["hbs", "text/x-handlebars"],
            ["handlebars", "text/x-handlebars"],
            ["mustache", "text/x-mustache"],
            ["ejs", "text/x-ejs"],
            ["j2", "text/x-jinja2"],
            ["jinja", "text/x-jinja2"],
            ["jinja2", "text/x-jinja2"],
            ["liquid", "text/x-liquid"],
            ["erb", "text/x-erb"],
            ["twig", "text/x-twig"],
            ["pug", "text/x-pug"],
            ["jade", "text/x-pug"],
            ["tmpl", "text/x-tmpl"],
            ["json", "application/json"],
            ["yml", "application/x-yaml"],
            ["yaml", "application/x-yaml"],
            ["toml", "application/toml"],
            ["ini", "text/plain"],
            ["properties", "text/plain"],
            ["env", "text/plain"],
            ["conf", "text/plain"],
            ["log", "text/plain"],
            ["txt", "text/plain"],
            ["flashcards", "text/plain"],
            ["xml", "text/xml"],
            ["astro", "text/x-astro"],
            ["avif", "image/avif"],
            ["jpg", "image/jpeg"],
            ["jpeg", "image/jpeg"],
            ["mpo", "image/jpeg"],
            ["png", "image/png"],
            ["gif", "image/gif"],
            ["webp", "image/webp"]
        ]);


    function getRoutingMimeType(
        attachment
    )
    {
        const extension =
            getFileExtension(
                attachment?.name
            );

        const override =
            FILE_NAME_MIME_OVERRIDES.get(
                extension
            );

        if (override)
        {
            return override;
        }

        const savedMime =
            typeof attachment?.mime_type === "string"
                ? attachment.mime_type.trim().toLowerCase()
                : "";

        /*
         * Saved recovery metadata normally carries the browser/MIME-DB
         * result for non-overridden file types (including Office and
         * OpenDocument files). We deliberately fail closed for attachment
         * restoration if that persistent metadata is absent or generic;
         * the recovery record is retained so the user can re-attach it.
         */
        if (
            !savedMime ||
            savedMime === "application/octet-stream"
        )
        {
            return null;
        }

        return savedMime;
    }


    function getModelConfigMaps(
        routeScope
    )
    {
        let node = routeScope?.node;
        const maps = [];

        for (
            let nodeDepth = 0;
            node && nodeDepth < 10;
            nodeDepth++, node = node.parent
        )
        {
            if (
                !node.familyBindings ||
                typeof node.familyBindings.entries !== "function"
            )
            {
                continue;
            }

            for (const [family, bindings] of node.familyBindings.entries())
            {
                if (
                    family?.kind !== "readable-family" ||
                    family?.scope?.__scopeBrand !== "AppScope"
                )
                {
                    continue;
                }

                let bindingKeys;

                try
                {
                    bindingKeys = [...bindings.keys()];
                }
                catch
                {
                    continue;
                }

                for (const bindingKey of bindingKeys)
                {
                    let value;

                    try
                    {
                        value = routeScope.get(
                            family,
                            bindingKey
                        );
                    }
                    catch
                    {
                        continue;
                    }

                    /*
                     * ChatGPT has exposed this map in both shapes during
                     * our live tests:
                     *
                     *   value.availableModels.modelConfigBySlug
                     *   value.modelConfigBySlug
                     *
                     * Discover either shape; never hard-code a family index.
                     */
                    for (const candidate of [
                        value?.availableModels?.modelConfigBySlug,
                        value?.modelConfigBySlug
                    ])
                    {
                        if (
                            candidate &&
                            typeof candidate === "object" &&
                            !Array.isArray(candidate) &&
                            Object.keys(candidate).length > 0 &&
                            !maps.includes(candidate)
                        )
                        {
                            maps.push(candidate);
                        }
                    }
                }
            }
        }

        return maps;
    }


    function findResolvedModelSlug(
        routeScope,
        conversationId
    )
    {
        let node = routeScope?.node;
        const matches = [];
        const requestedModelSlugs = [];
        const modelConfigMaps =
            getModelConfigMaps(routeScope);

        function hasAttachmentModelConfig(
            slug
        )
        {
            return modelConfigMaps.some(
                map => map[slug]?.attachments
            );
        }

        function getRequestedModelSlug(
            bindingKey
        )
        {
            if (typeof bindingKey !== "string")
            {
                return null;
            }

            let parsed;

            try
            {
                parsed = JSON.parse(bindingKey);
            }
            catch
            {
                return null;
            }

            const target =
                parsed?.conversationDetailsTarget;

            if (!target)
            {
                return null;
            }

            if (
                target.clientConversationId !== conversationId &&
                target.serverConversationId !== conversationId &&
                parsed?.conversationId !== conversationId
            )
            {
                return null;
            }

            const requested =
                target.requestedDefaultModel;

            if (
                typeof requested !== "string" ||
                !requested ||
                !hasAttachmentModelConfig(requested)
            )
            {
                return null;
            }

            return requested;
        }

        /*
         * Attachment routing must use the same concrete model slug that
         * ChatGPT's send-time validator will use. During reload ChatGPT can
         * temporarily expose two different valid-looking identities: the
         * conversation-details requestedDefaultModel and compact current-model
         * state directly bound to the conversation. Do not choose either side
         * while they disagree. Agreement is our readiness signal.
         */
        for (
            let nodeDepth = 0;
            node && nodeDepth < 10;
            nodeDepth++, node = node.parent
        )
        {
            if (
                !node.familyBindings ||
                typeof node.familyBindings.entries !== "function"
            )
            {
                continue;
            }

            for (const [family, bindings] of node.familyBindings.entries())
            {
                if (
                    family?.kind !== "readable-family" ||
                    family?.scope?.__scopeBrand !== "AppScope"
                )
                {
                    continue;
                }

                let bindingKeys;

                try
                {
                    bindingKeys = [...bindings.keys()];
                }
                catch
                {
                    continue;
                }

                for (const bindingKey of bindingKeys)
                {
                    const requestedModelSlug =
                        getRequestedModelSlug(bindingKey);

                    if (requestedModelSlug)
                    {
                        requestedModelSlugs.push(
                            requestedModelSlug
                        );
                    }

                    let value;

                    try
                    {
                        value = routeScope.get(
                            family,
                            bindingKey
                        );
                    }
                    catch
                    {
                        continue;
                    }

                    if (
                        !value ||
                        typeof value !== "object" ||
                        Array.isArray(value) ||
                        typeof value.slug !== "string" ||
                        !value.slug ||
                        !("versionId" in value) ||
                        !("thinkingEffort" in value) ||
                        !hasAttachmentModelConfig(value.slug)
                    )
                    {
                        continue;
                    }

                    matches.push({
                        slug: value.slug,
                        bindingKey,
                        isDirectConversationBinding:
                            bindingKey === conversationId
                    });
                }
            }
        }

        const uniqueRequestedModelSlugs = [
            ...new Set(requestedModelSlugs)
        ];
        const directMatches =
            matches.filter(
                match => match.isDirectConversationBinding
            );
        const uniqueDirectSlugs = [
            ...new Set(
                directMatches.map(
                    match => match.slug
                )
            )
        ];

        if (uniqueRequestedModelSlugs.length > 1)
        {
            return {
                success: false,
                requestedModelSlugs: uniqueRequestedModelSlugs,
                directModelSlugs: uniqueDirectSlugs,
                error:
                    "Expected at most one concrete conversation-details model slug with attachment configuration; found " +
                    uniqueRequestedModelSlugs.length +
                    "."
            };
        }

        if (uniqueDirectSlugs.length > 1)
        {
            return {
                success: false,
                requestedModelSlugs: uniqueRequestedModelSlugs,
                directModelSlugs: uniqueDirectSlugs,
                error:
                    "Expected at most one directly conversation-bound current-model slug with attachment configuration; found " +
                    uniqueDirectSlugs.length +
                    "."
            };
        }

        if (
            uniqueRequestedModelSlugs.length === 1 &&
            uniqueDirectSlugs.length === 1
        )
        {
            if (
                uniqueRequestedModelSlugs[0] !==
                uniqueDirectSlugs[0]
            )
            {
                return {
                    success: false,
                    requestedModelSlugs: uniqueRequestedModelSlugs,
                    directModelSlugs: uniqueDirectSlugs,
                    error:
                        "Conversation model state is still settling: conversation-details and direct current-model state disagree."
                };
            }

            return {
                success: true,
                modelSlug: uniqueDirectSlugs[0],
                source: "conversation-model-agreement",
                requestedModelSlugs: uniqueRequestedModelSlugs,
                directModelSlugs: uniqueDirectSlugs
            };
        }

        if (uniqueDirectSlugs.length === 1)
        {
            return {
                success: true,
                modelSlug: uniqueDirectSlugs[0],
                source: "direct-conversation-model",
                requestedModelSlugs: uniqueRequestedModelSlugs,
                directModelSlugs: uniqueDirectSlugs
            };
        }

        if (uniqueRequestedModelSlugs.length === 1)
        {
            return {
                success: false,
                requestedModelSlugs: uniqueRequestedModelSlugs,
                directModelSlugs: uniqueDirectSlugs,
                error:
                    "Conversation-details model is available, but directly conversation-bound current-model state is not ready yet."
            };
        }

        return {
            success: false,
            requestedModelSlugs: uniqueRequestedModelSlugs,
            directModelSlugs: uniqueDirectSlugs,
            error:
                "No unambiguous conversation-bound attachment model state is ready yet."
        };
    }


    async function waitForStableAttachmentModel(
        routeScope,
        conversationId
    )
    {
        const startedAt = Date.now();
        const stableForMs = 1000;
        const initialObservationMs = 5000;
        const timeoutMs = 300000;
        const pollMs = 500;
        let lastKey = null;
        let stableSince = null;
        let lastObservedKey = null;
        let lastObserved = null;

        while (Date.now() - startedAt < timeoutMs)
        {
            const selected =
                findResolvedModelSlug(
                    routeScope,
                    conversationId
                );

            const observedKey = JSON.stringify({
                success: selected.success,
                modelSlug: selected.modelSlug ?? null,
                source: selected.source ?? null,
                requestedModelSlugs:
                    selected.requestedModelSlugs ?? [],
                directModelSlugs:
                    selected.directModelSlugs ?? [],
                error: selected.error ?? null
            });

            if (observedKey !== lastObservedKey)
            {
                console.log(
                    "[ChatGPT Sync] Attachment model state changed during settle",
                    {
                        success: selected.success,
                        resolvedModel:
                            selected.modelSlug ?? null,
                        source:
                            selected.source ?? null,
                        requestedModelSlugs:
                            selected.requestedModelSlugs ?? [],
                        directModelSlugs:
                            selected.directModelSlugs ?? [],
                        error:
                            selected.error ?? null,
                        elapsedMs:
                            Date.now() - startedAt
                    }
                );

                lastObservedKey = observedKey;
                lastObserved = selected;
            }

            if (selected.success)
            {
                const key = [
                    selected.modelSlug,
                    selected.source
                ].join("|");

                if (key !== lastKey)
                {
                    lastKey = key;
                    stableSince = Date.now();
                }

                if (
                    stableSince !== null &&
                    Date.now() - startedAt >= initialObservationMs &&
                    Date.now() - stableSince >= stableForMs
                )
                {
                    return {
                        ...selected,
                        settleElapsedMs:
                            Date.now() - startedAt
                    };
                }
            }
            else
            {
                lastKey = null;
                stableSince = null;
            }

            await new Promise(
                resolve => setTimeout(resolve, pollMs)
            );
        }

        return {
            success: false,
            error:
                "Attachment model state did not become ready before the 5-minute restoration timeout." +
                (
                    lastObserved
                        ? " Last state: " +
                          (
                              lastObserved.error ||
                              lastObserved.modelSlug ||
                              "unknown"
                          ) +
                          "."
                        : ""
                )
        };
    }


    function findModelAttachmentConfig(
        routeScope,
        modelSlug
    )
    {
        const maps =
            getModelConfigMaps(routeScope);
        const matches = [];

        for (const modelConfigBySlug of maps)
        {
            const config =
                modelConfigBySlug[modelSlug];

            if (config?.attachments)
            {
                matches.push(config.attachments);
            }
        }

        const unique = [];

        for (const value of matches)
        {
            if (!unique.includes(value))
            {
                unique.push(value);
            }
        }

        if (unique.length !== 1 || !unique[0])
        {
            return {
                success: false,
                error:
                    "Expected exactly one attachment configuration for resolved model " +
                    modelSlug +
                    "; found " +
                    unique.length +
                    "."
            };
        }

        return {
            success: true,
            attachments: unique[0]
        };
    }


    function classifyAttachmentRouting(
        attachment,
        modelSlug,
        modelAttachments
    )
    {
        const mimeType =
            getRoutingMimeType(
                attachment
            );

        if (!mimeType)
        {
            return null;
        }

        let useCase = "my_files";

        if (mimeType.startsWith("image/"))
        {
            useCase = "multimodal";
        }
        else
        {
            const acceptedMimeTypes =
                modelAttachments?.accepted_mime_types;

            if (
                modelAttachments?.type === "code_interpreter" ||
                (
                    modelAttachments?.type === "retrieval" &&
                    modelAttachments?.can_accept_all_mime_types === true &&
                    Array.isArray(acceptedMimeTypes) &&
                    acceptedMimeTypes.length > 0 &&
                    !acceptedMimeTypes.includes(mimeType)
                )
            )
            {
                useCase = "ace_upload";
            }
        }

        /*
         * ChatGPT special-cases Hancom HWP/HWPX away from ace_upload.
         */
        const extension =
            getFileExtension(
                attachment?.name
            );

        if (
            useCase === "ace_upload" &&
            (
                extension === "hwp" ||
                extension === "hwpx"
            )
        )
        {
            useCase = "my_files";
        }

        return {
            useCase,
            mimeType,
            pdfModelSlug:
                mimeType === "application/pdf"
                    ? modelSlug
                    : undefined
        };
    }


    function getRecoverableAttachments(
        message,
        modelSlug,
        modelAttachments
    )
    {
        const attachments = message?.metadata?.attachments;

        if (!Array.isArray(attachments))
        {
            return [];
        }

        return attachments
            .map(attachment =>
            {
                if (
                    typeof attachment?.id !== "string" ||
                    typeof attachment?.library_file_id !== "string" ||
                    typeof attachment?.name !== "string" ||
                    typeof attachment?.size !== "number"
                )
                {
                    return null;
                }

                const uploadRouting =
                    classifyAttachmentRouting(
                        attachment,
                        modelSlug,
                        modelAttachments
                    );

                if (!uploadRouting)
                {
                    return null;
                }

                const restored = {
                    uploadRouting,
                    id: attachment.id,
                    libraryFileId: attachment.library_file_id,
                    mimeType:
                        typeof attachment.mime_type === "string" &&
                        attachment.mime_type
                            ? attachment.mime_type
                            : uploadRouting.mimeType,
                    name: attachment.name,
                    size: attachment.size,
                    status: "ready",
                    uploadId: crypto.randomUUID()
                };

                if (typeof attachment.width === "number")
                {
                    restored.width = attachment.width;
                }

                if (typeof attachment.height === "number")
                {
                    restored.height = attachment.height;
                }

                return restored;
            })
            .filter(Boolean);
    }

    async function waitForAttachmentState(
        conversationId,
        timeoutMilliseconds = 10000
    )
    {
        const startedAt = performance.now();
        let attempt = 0;
        let lastError = null;
        let previousComposer = null;

        while (performance.now() - startedAt < timeoutMilliseconds)
        {
            attempt++;

            const composer = findComposerForm();
            const composerReplaced =
                previousComposer !== null &&
                composer !== previousComposer;

            previousComposer = composer;

            const discovered =
                discoverAttachmentState(
                    conversationId
                );

            lastError =
                discovered.error ?? null;

            console.log(
                "[ChatGPT Sync] Attachment state discovery attempt.",
                {
                    attempt,
                    elapsedMs: Math.round(
                        performance.now() - startedAt
                    ),
                    composerFound: Boolean(composer),
                    composerConnected: Boolean(composer?.isConnected),
                    composerReplaced,
                    success: discovered.success,
                    storeKind:
                        discovered.attachmentStore?.kind ?? null,
                    fiberDepth:
                        discovered.attachmentStore?.fiberDepth ?? null,
                    contextIndex:
                        discovered.attachmentStore?.contextIndex ?? null,
                    error: discovered.error ?? null
                }
            );

            if (discovered.success)
            {
                return discovered;
            }

            await new Promise(resolve =>
            {
                setTimeout(resolve, 100);
            });
        }

        return {
            success: false,
            error:
                lastError ??
                "Attachment state discovery timed out."
        };
    }


    function getWritableContextRecoverableAttachments(
        message
    )
    {
        const attachments =
            message?.metadata?.attachments;

        if (!Array.isArray(attachments))
        {
            return [];
        }

        return attachments
            .map(attachment =>
            {
                if (
                    typeof attachment?.id !== "string" ||
                    typeof attachment?.name !== "string" ||
                    typeof attachment?.size !== "number" ||
                    typeof attachment?.mime_type !== "string" ||
                    !attachment.mime_type
                )
                {
                    return null;
                }

                const restored = {
                    id: attachment.id,
                    libraryFileId:
                        typeof attachment.library_file_id === "string"
                            ? attachment.library_file_id
                            : null,
                    mimeType: attachment.mime_type,
                    name: attachment.name,
                    size: attachment.size,
                    source:
                        typeof attachment.source === "string"
                            ? attachment.source
                            : "local",
                    isBigPaste:
                        attachment.is_big_paste === true,
                    status: "ready",
                    uploadId: crypto.randomUUID()
                };

                if (typeof attachment.width === "number")
                {
                    restored.width = attachment.width;
                }

                if (typeof attachment.height === "number")
                {
                    restored.height = attachment.height;
                }

                return restored;
            })
            .filter(Boolean);
    }


    function createReferenceOnlyBrowserFile(
        attachment
    )
    {
        /*
         * Firefox Android's attachment renderer requires a genuine File
         * object even for a completed server-side attachment. Live testing
         * proved that the original bytes are not required: a zero-byte File
         * with the correct name/type renders and submits using fileId /
         * libraryFileId, while file: null crashes ChatGPT's React boundary.
         */
        return new File(
            [],
            attachment.name,
            {
                type: attachment.mimeType
            }
        );
    }


    function toWritableContextAttachment(
        attachment
    )
    {
        const file =
            createReferenceOnlyBrowserFile(
                attachment
            );

        const fileSignature = JSON.stringify({
            name: attachment.name,
            size: attachment.size,
            lastModified: file.lastModified,
            type: attachment.mimeType
        });

        return {
            tempId:
                `chatgpt-sync-recovery-${crypto.randomUUID()}:lib`,
            productExperience: undefined,
            gizmoId: undefined,
            fileSignature,
            status: "ready",
            file,
            progress: 1,
            fileId: attachment.id,
            cdnUrl: null,
            contextConnectorInfo: undefined,
            contextConnector: undefined,
            isBigPaste: attachment.isBigPaste === true,
            bigPasteCharCount: undefined,
            mode: undefined,
            previewContent: undefined,
            source: attachment.source ?? "local",
            storeInLibrary: Boolean(attachment.libraryFileId),
            isTemporaryChat: false,
            libraryEligibilityReason: undefined,
            isProjectThread: false,
            uploadSlotPrefetchAttribution: undefined,
            fileSpec: {
                audioDurationSeconds: undefined,
                name: attachment.name,
                id: attachment.id,
                size: attachment.size,
                contextConnectorInfo: undefined,
                isBigPaste: attachment.isBigPaste === true,
                fileTokenSize: undefined,
                mimeType: attachment.mimeType,
                nonLibraryMyFilesInjestUpload: undefined,
                libraryFileId: attachment.libraryFileId,
                libraryFileName:
                    attachment.libraryFileId
                        ? attachment.name
                        : null,
                libraryPersistenceResult: undefined,
                libraryPersistenceReason: undefined,
                thumbnail: undefined,
                transcript: undefined
            },

            /*
             * Keep the desktop identity fields too. They are harmless in the
             * context store and make recovery verification platform-neutral.
             */
            id: attachment.id,
            libraryFileId: attachment.libraryFileId,
            mimeType: attachment.mimeType,
            name: attachment.name,
            size: attachment.size,
            uploadId: attachment.uploadId,
            uploadRouting: attachment.uploadRouting
        };
    }


    function getAttachmentStoreState(
        discovered,
        conversationId
    )
    {
        if (discovered.attachmentStore?.kind === "writable-context")
        {
            return discovered.attachmentStore.context.files$();
        }

        return discovered.routeScope.get(
            discovered.attachmentFamily,
            conversationId
        );
    }


    function appendAttachmentStoreState(
        discovered,
        conversationId,
        missing
    )
    {
        if (discovered.attachmentStore?.kind === "writable-context")
        {
            const androidAttachments =
                missing.map(
                    toWritableContextAttachment
                );

            discovered.attachmentStore.context.files$.set(
                current => [
                    ...current,
                    ...androidAttachments
                ]
            );

            return;
        }

        discovered.routeScope.set(
            discovered.attachmentFamily,
            conversationId,
            current => [
                ...current,
                ...missing
            ]
        );
    }


    function attachmentIdentity(
        attachment
    )
    {
        return [
            attachment?.id ?? attachment?.fileId ?? null,
            attachment?.libraryFileId ?? null
        ].join("|");
    }


    async function restoreRecoveryAttachments(
        conversationId,
        message
    )
    {
        const savedMetadata = message?.metadata?.attachments;

        if (!Array.isArray(savedMetadata) || savedMetadata.length === 0)
        {
            return {
                success: true,
                requestedCount: 0,
                restoredCount: 0,
                alreadyPresentCount: 0
            };
        }

        const discovered =
            await waitForAttachmentState(
                conversationId
            );

        if (!discovered.success)
        {
            return {
                success: false,
                requestedCount: savedMetadata.length,
                restoredCount: 0,
                error: discovered.error
            };
        }

        if (discovered.attachmentStore?.kind === "writable-context")
        {
            const restored =
                getWritableContextRecoverableAttachments(
                    message
                );

            if (restored.length !== savedMetadata.length)
            {
                return {
                    success: false,
                    requestedCount: savedMetadata.length,
                    restoredCount: 0,
                    error: "Recovery contains an attachment without sufficient persistent metadata for writable-context restoration."
                };
            }

            const existingIds = new Set(
                discovered.currentAttachments.map(attachmentIdentity)
            );

            const missing = restored.filter(attachment =>
                !existingIds.has(attachmentIdentity(attachment))
            );

            if (missing.length > 0)
            {
                appendAttachmentStoreState(
                    discovered,
                    conversationId,
                    missing
                );
            }

            const finalState =
                getAttachmentStoreState(
                    discovered,
                    conversationId
                );

            const finalIds = new Set(
                finalState.map(attachmentIdentity)
            );

            const allPresent = restored.every(attachment =>
                finalIds.has(attachmentIdentity(attachment))
            );

            return {
                success: allPresent,
                requestedCount: restored.length,
                restoredCount: missing.length,
                alreadyPresentCount:
                    restored.length - missing.length,
                finalCount: finalState.length,
                storeKind: "writable-context",
                error: allPresent
                    ? null
                    : "Not all attachment references were present after writable-context restoration."
            };
        }

        const selectedModel =
            await waitForStableAttachmentModel(
                discovered.routeScope,
                conversationId
            );

        if (!selectedModel.success)
        {
            return {
                success: false,
                requestedCount: savedMetadata.length,
                restoredCount: 0,
                error: selectedModel.error
            };
        }

        console.log(
            "[ChatGPT Sync] Resolved attachment model",
            {
                resolvedModel:
                    selectedModel.modelSlug,
                source:
                    selectedModel.source,
                settleElapsedMs:
                    selectedModel.settleElapsedMs
            }
        );

        const modelConfig =
            findModelAttachmentConfig(
                discovered.routeScope,
                selectedModel.modelSlug
            );

        if (!modelConfig.success)
        {
            return {
                success: false,
                requestedCount: savedMetadata.length,
                restoredCount: 0,
                error: modelConfig.error
            };
        }

        const restored =
            getRecoverableAttachments(
                message,
                selectedModel.modelSlug,
                modelConfig.attachments
            );

        /*
         * Be deliberately conservative: every saved attachment must
         * have enough persistent metadata to reconstruct a route that
         * matches ChatGPT's current selected-model classifier.
         */
        if (restored.length !== savedMetadata.length)
        {
            return {
                success: false,
                requestedCount: savedMetadata.length,
                restoredCount: 0,
                error: "Recovery contains an attachment that could not be classified safely for the current model."
            };
        }


        const existingIds = new Set(
            discovered.currentAttachments.map(attachmentIdentity)
        );

        const missing = restored.filter(attachment =>
            !existingIds.has(attachmentIdentity(attachment))
        );

        if (missing.length > 0)
        {
            appendAttachmentStoreState(
                discovered,
                conversationId,
                missing
            );
        }

        const finalState =
            getAttachmentStoreState(
                discovered,
                conversationId
            );

        const finalIds = new Set(
            finalState.map(attachmentIdentity)
        );

        const allPresent = restored.every(attachment =>
            finalIds.has(attachmentIdentity(attachment))
        );

        return {
            success: allPresent,
            requestedCount: restored.length,
            restoredCount: missing.length,
            alreadyPresentCount:
                restored.length - missing.length,
            finalCount: finalState.length,
            error: allPresent
                ? null
                : "Not all attachment references were present after restoration."
        };
    }


    function findComposerTextCallback(
        composerForm
    )
    {
        const fiber =
            getReactFiberFromElement(
                composerForm
            );

        if (!fiber)
        {
            return {
                success: false,
                error: "React Fiber was not found on the composer form."
            };
        }

        const seenFibers = new Set();
        const callbacks = new Set();

        function walk(
            current,
            depth
        )
        {
            if (
                !current ||
                depth > 20 ||
                seenFibers.has(current)
            )
            {
                return;
            }

            seenFibers.add(current);

            for (const property of [
                "memoizedProps",
                "pendingProps"
            ])
            {
                const callback =
                    current[property]?.onComposerText;

                if (
                    typeof callback === "function" &&
                    callback.length === 1
                )
                {
                    callbacks.add(callback);
                }
            }

            walk(
                current.child,
                depth + 1
            );

            walk(
                current.sibling,
                depth
            );
        }

        walk(
            fiber,
            0
        );

        if (callbacks.size !== 1)
        {
            return {
                success: false,
                error:
                    "Expected exactly one semantic onComposerText callback; found " +
                    callbacks.size +
                    "."
            };
        }

        return {
            success: true,
            callback: [...callbacks][0]
        };
    }


    window.addEventListener(
        "message",
        async event =>
        {
            if (
                event.source !== window ||
                event.data?.source !== MESSAGE_SOURCE ||
                event.data?.type !== "restore-recovery-composer-text"
            )
            {
                return;
            }

            const requestId = event.data.requestId;
            const conversationId = event.data.conversationId;
            const text = event.data.text;
            let result;

            try
            {
                if (
                    !requestId ||
                    !conversationId ||
                    conversationId !== getConversationIdFromLocation() ||
                    typeof text !== "string" ||
                    !text
                )
                {
                    result = {
                        success: false,
                        error: "Composer text restore request is invalid or does not match the current conversation."
                    };
                }
                else
                {
                    const composerForm =
                        await waitForComposerForm();

                    if (!composerForm)
                    {
                        result = {
                            success: false,
                            error: "Composer form did not become available before text restoration timed out."
                        };
                    }
                    else
                    {
                        const editor =
                            composerForm.querySelector(
                                '.ProseMirror[contenteditable="true"]'
                            );

                        const existingText =
                            (
                                editor?.innerText ??
                                editor?.textContent ??
                                ""
                            ).trim();

                        if (existingText)
                        {
                            result = {
                                success: false,
                                error: "Composer already contains text; refusing to overwrite it."
                            };
                        }
                        else
                        {
                            const discovery =
                                findComposerTextCallback(
                                    composerForm
                                );

                            if (!discovery.success)
                            {
                                result = discovery;
                            }
                            else
                            {
                                discovery.callback(
                                    text
                                );

                                const currentEditor =
                                    composerForm.querySelector(
                                        '.ProseMirror[contenteditable="true"]'
                                    );

                                result = {
                                    success: true,
                                    restoredText:
                                        currentEditor?.textContent ??
                                        null
                                };
                            }
                        }
                    }
                }
            }
            catch (error)
            {
                result = {
                    success: false,
                    error: error?.message ?? String(error)
                };
            }

            notifyExtension(
                "restore-recovery-composer-text-result",
                {
                    requestId,
                    result
                }
            );
        }
    );


    window.addEventListener(
        "message",
        async event =>
        {
            if (
                event.source !== window ||
                event.data?.source !== MESSAGE_SOURCE ||
                event.data?.type !== "restore-recovery-attachments"
            )
            {
                return;
            }

            const requestId = event.data.requestId;
            const conversationId = event.data.conversationId;
            let result;

            try
            {
                if (
                    !requestId ||
                    !conversationId ||
                    conversationId !== getConversationIdFromLocation()
                )
                {
                    result = {
                        success: false,
                        error: "Attachment restore request does not match the current conversation."
                    };
                }
                else
                {
                    const composer =
                        await waitForComposerForm();

                    if (!composer)
                    {
                        result = {
                            success: false,
                            error: "Composer form did not become available before attachment restoration timed out."
                        };
                    }
                    else
                    {
                        result = await restoreRecoveryAttachments(
                            conversationId,
                            event.data.message
                        );
                    }
                }
            }
            catch (error)
            {
                result = {
                    success: false,
                    error: error?.message ?? String(error)
                };
            }

            notifyExtension(
                "restore-recovery-attachments-result",
                {
                    requestId,
                    result
                }
            );
        }
    );


    window.fetch =
        async function (...args)
        {
            const input =
                args[0];

            const init =
                args[1];

            let protectedUserSend =
                null;


            try
            {
                const url =
                    typeof input ===
                    "string"
                        ? input
                        : input?.url;


                const method =
                    init?.method ??
                    input?.method;


                if (
                    !url ||
                    !url.includes(
                        "/backend-api/f/conversation"
                    ) ||
                    method?.toUpperCase() !==
                        "POST"
                )
                {
                    return originalFetch.apply(
                        this,
                        args
                    );
                }


                const rawBody =
                    init?.body;


                if (
                    typeof rawBody !==
                    "string"
                )
                {
                    return originalFetch.apply(
                        this,
                        args
                    );
                }


                let body;


                try
                {
                    body =
                        JSON.parse(
                            rawBody
                        );
                }
                catch
                {
                    return originalFetch.apply(
                        this,
                        args
                    );
                }


                if (
                    !body?.conversation_id ||
                    !body?.parent_message_id ||
                    body?.action !==
                        "next"
                )
                {
                    return originalFetch.apply(
                        this,
                        args
                    );
                }


                const conversationId =
                    body.conversation_id;

                const parentMessageId =
                    body.parent_message_id;


                const userMessage =
                    getUserMessage(
                        body
                    );

                const messageText =
                    getMessageText(
                        userMessage
                    );


                if (userMessage)
                {
                    protectedUserSend =
                    {
                        conversationId,

                        parentMessageId,

                        userMessage,

                        messageText
                    };
                }


                console.log(
                    "[ChatGPT Sync] Outgoing conversation operation",
                    {
                        conversationId,

                        parentMessageId,

                        hasUserMessage:
                            Boolean(
                                userMessage
                            ),

                        userMessageText:
                            messageText,

                        userMessageId:
                            getMessageId(
                                userMessage
                            )
                    }
                );


                /*
                 * Recovery can remain pending after the visible ChatGPT UI
                 * appears ready. During that interval the content script
                 * places a synchronous DOM lock on the document element.
                 * Background operations are still allowed, but a genuine
                 * user send must not escape before recovered attachments are
                 * ready.
                 */
                if (
                    userMessage &&
                    document.documentElement.getAttribute(
                        RECOVERY_LOCK_ATTRIBUTE
                    ) === "true"
                )
                {
                    console.log(
                        "[ChatGPT Sync] BLOCKED - user send while recovery is still in progress.",
                        {
                            conversationId,
                            parentMessageId,
                            userMessageId:
                                getMessageId(
                                    userMessage
                                )
                        }
                    );

                    return Promise.reject(
                        new Error(
                            "ChatGPT Sync is still restoring this recovered message."
                        )
                    );
                }


                /*
                 * FAST PATH FOR AN ALREADY-PROVEN STALE
                 * LOCAL PARENT.
                 */
                if (
                    operationMatchesKnownStaleState(
                        conversationId,
                        parentMessageId
                    )
                )
                {
                    return blockKnownStaleOperation(
                        conversationId,
                        parentMessageId,
                        userMessage,
                        messageText
                    );
                }


                const requestHeaders =
                    new Headers(
                        init?.headers ??
                        input?.headers
                    );


                const authorization =
                    requestHeaders.get(
                        "authorization"
                    );


                if (!authorization)
                {
                    console.error(
                        "[ChatGPT Sync] Cannot perform state check: " +
                        "outgoing request has no Authorization header."
                    );


                    if (!userMessage)
                    {
                        return originalFetch.apply(
                            this,
                            args
                        );
                    }


                    notifyExtension(
                        "state-verification-failed",
                        {
                            conversationId,

                            failure:
                            {
                                kind:
                                    "missing-authorization"
                            },

                            retryAfterMs:
                                10000,

                            retryAt:
                                new Date(
                                    Date.now() +
                                    10000
                                ).toISOString(),

                            messageText:
                                messageText ?? "",

                            message:
                                cloneMessage(
                                    userMessage
                                )
                        }
                    );


                    return Promise.reject(
                        new Error(
                            "ChatGPT Sync blocked this message because " +
                            "conversation state could not be verified."
                        )
                    );
                }


                const stateUrl =
                    `/backend-api/conversations/${conversationId}` +
                    "?num_turns=100&include_has_versions=true";


                let serverState;


                if (userMessage)
                {
                    const verification =
                        await verifyUserSendState(
                            stateUrl,
                            authorization,
                            conversationId,
                            userMessage,
                            messageText
                        );


                    if (!verification.ok)
                    {
                        console.log(
                            "[ChatGPT Sync] BLOCKED - user send because authoritative state could not be verified.",
                            {
                                conversationId,
                                parentMessageId,
                                failure:
                                    verification.failure
                            }
                        );


                        return Promise.reject(
                            new Error(
                                "ChatGPT Sync blocked this message because " +
                                "conversation state could not be verified."
                            )
                        );
                    }


                    serverState =
                        verification.serverState;
                }
                else
                {
                    let stateResponse;


                    try
                    {
                        stateResponse =
                            await requestAuthoritativeState(
                                stateUrl,
                                authorization
                            );
                    }
                    catch (error)
                    {
                        console.error(
                            "[ChatGPT Sync] Background state check error:",
                            error
                        );


                        return originalFetch.apply(
                            this,
                            args
                        );
                    }


                    if (!stateResponse.ok)
                    {
                        console.error(
                            "[ChatGPT Sync] Background state check failed",
                            {
                                status:
                                    stateResponse.status,

                                statusText:
                                    stateResponse.statusText
                            }
                        );


                        return originalFetch.apply(
                            this,
                            args
                        );
                    }


                    try
                    {
                        serverState =
                            await stateResponse.json();
                    }
                    catch (error)
                    {
                        console.error(
                            "[ChatGPT Sync] Could not parse background state response:",
                            error
                        );


                        return originalFetch.apply(
                            this,
                            args
                        );
                    }


                    if (!serverState.current_node)
                    {
                        console.error(
                            "[ChatGPT Sync] Background state response has no current_node."
                        );


                        return originalFetch.apply(
                            this,
                            args
                        );
                    }
                }


                const serverCurrentNode =
                    serverState.current_node;


                console.log(
                    "[ChatGPT Sync] State comparison",
                    {
                        localParentMessageId:
                            parentMessageId,

                        serverCurrentNode
                    }
                );


                /*
                 * HEALTHY
                 */
                if (
                    parentMessageId ===
                    serverCurrentNode
                )
                {
                    if (
                        window.__chatgptSync
                            .knownStale
                            ?.conversationId ===
                        conversationId
                    )
                    {
                        window.__chatgptSync
                            .knownStale =
                            null;
                    }


                    console.log(
                        "[ChatGPT Sync] SAFE - " +
                        "conversation is in sync."
                    );


                    return allowOperation(
                        this,
                        args,
                        conversationId,
                        parentMessageId,
                        userMessage,
                        messageText
                    );
                }


                /*
                 * POSITIVELY STALE
                 */
                const staleState =
                {
                    conversationId,

                    localParentMessageId:
                        parentMessageId,

                    serverCurrentNode,

                    detectedAt:
                        new Date()
                            .toISOString()
                };


                window.__chatgptSync
                    .knownStale =
                    staleState;


                if (!userMessage)
                {
                    /*
                     * Again, this is successful protection,
                     * not a browser-extension warning.
                     */
                    console.log(
                        "[ChatGPT Sync] BLOCKED - " +
                        "stale background conversation operation.",
                        {
                            localParentMessageId:
                                parentMessageId,

                            serverCurrentNode,

                            hasUserMessage:
                                false
                        }
                    );


                    notifyExtension(
                        "stale-detected",
                        {
                            staleState
                        }
                    );


                    return Promise.reject(
                        new Error(
                            "ChatGPT Sync blocked a stale " +
                            "background conversation operation."
                        )
                    );
                }


                const recovery =
                    createRecovery(
                        conversationId,
                        parentMessageId,
                        serverCurrentNode,
                        userMessage,
                        messageText
                    );


                window.__chatgptSync
                    .lastBlockedMessage =
                    recovery;


                console.log(
                    "[ChatGPT Sync] BLOCKED - " +
                    "stale user send.",
                    {
                        localParentMessageId:
                            parentMessageId,

                        serverCurrentNode,

                        blockedMessageText:
                            messageText,

                        messageId:
                            recovery.messageId
                    }
                );


                notifyExtension(
                    "stale-send-blocked",
                    {
                        recovery
                    }
                );


                return Promise.reject(
                    new Error(
                        "ChatGPT Sync blocked this message because " +
                        "the conversation is out of sync."
                    )
                );
            }
            catch (error)
            {
                console.error(
                    "[ChatGPT Sync] Interceptor error:",
                    error
                );


                /*
                 * Defence in depth:
                 *
                 * Once this invocation has been positively
                 * identified as a genuine user send, ANY
                 * unexpected failure in our protection logic
                 * must fail closed. The original conversation
                 * POST is never sent from this path.
                 *
                 * Non-user/background operations retain the
                 * historical fail-open behaviour.
                 */
                if (protectedUserSend)
                {
                    console.error(
                        "[ChatGPT Sync] BLOCKED - genuine user send because the interceptor failed unexpectedly.",
                        {
                            conversationId:
                                protectedUserSend
                                    .conversationId,

                            parentMessageId:
                                protectedUserSend
                                    .parentMessageId,

                            error:
                                String(
                                    error
                                )
                        }
                    );


                    notifyExtension(
                        "state-verification-failed",
                        {
                            conversationId:
                                protectedUserSend
                                    .conversationId,

                            failure:
                            {
                                kind:
                                    "interceptor-error",

                                error:
                                    String(
                                        error
                                    )
                            },

                            retryAfterMs:
                                10000,

                            retryAt:
                                new Date(
                                    Date.now() +
                                    10000
                                ).toISOString(),

                            messageText:
                                protectedUserSend
                                    .messageText ??
                                "",

                            message:
                                cloneMessage(
                                    protectedUserSend
                                        .userMessage
                                )
                        }
                    );


                    return Promise.reject(
                        new Error(
                            "ChatGPT Sync blocked this message because " +
                            "the interceptor failed unexpectedly."
                        )
                    );
                }


                return originalFetch.apply(
                    this,
                    args
                );
            }
        };


    console.log(
        "[ChatGPT Sync] Interceptor installed."
    );
})();