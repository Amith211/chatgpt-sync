(() =>
{
    /*
     * Development mode selector.
     *
     * Supported values:
     *
     *     "warn-early"
     *     "on-send"
     *     "auto-sync"
     */
    const MODE =
        "on-send";


    const MESSAGE_SOURCE =
        "chatgpt-sync";

    const RECOVERY_KEY_PREFIX =
        "chatgpt-sync:recovery:";

    const BANNER_ID =
        "chatgpt-sync-banner";

    const RECOVERY_STATUS_ID =
        "chatgpt-sync-recovery-status";

    const RECOVERY_LOCK_ATTRIBUTE =
        "data-chatgpt-sync-recovery-lock";


    /*
     * UI state machine.
     *
     * Normal stale progression:
     *
     *     healthy
     *        ↓
     *      stale
     *        ↓
     *   blocked-send
     *
     * A reload starts a fresh page context, so syncState
     * naturally begins as healthy again.
     */
    const DOCUMENT_INSTANCE_ID =
        crypto.randomUUID();

    let recoveryStatusIntervalId =
        null;

    let recoveryStatusObserver =
        null;

    let recoveryStatusState =
        null;


    let verificationBannerIntervalId =
        null;

    let syncState =
        "healthy";

    let knownStaleConversationId =
        null;

    let blockedSendUiObserver =
        null;

    let responsiveUiFrameId =
        null;


    function injectInterceptor()
    {
        const script =
            document.createElement(
                "script"
            );

        script.src =
            chrome.runtime.getURL(
                "interceptor.js"
            );

        (
            document.head ||
            document.documentElement
        ).appendChild(
            script
        );

        script.onload = () =>
        {
            script.remove();
        };
    }


    function getCurrentConversationId()
    {
        const match =
            window.location.pathname.match(
                /^\/c\/([^/?#]+)/
            );

        return match?.[1] ?? null;
    }


    function getRecoveryKey(
        conversationId
    )
    {
        return (
            RECOVERY_KEY_PREFIX +
            conversationId
        );
    }


    function saveRecovery(
        recovery
    )
    {
        if (
            !recovery?.conversationId ||
            (
                !recovery?.text &&
                !recovery?.message
            )
        )
        {
            return;
        }


        try
        {
            sessionStorage.setItem(
                getRecoveryKey(
                    recovery.conversationId
                ),
                JSON.stringify(
                    recovery
                )
            );


            console.log(
                "[ChatGPT Sync] Recovery draft saved.",
                {
                    conversationId:
                        recovery.conversationId,

                    text:
                        recovery.text,

                    messageId:
                        recovery.messageId ??
                        null
                }
            );
        }
        catch (error)
        {
            console.error(
                "[ChatGPT Sync] Could not save recovery draft:",
                error
            );
        }
    }


    function loadRecovery(
        conversationId
    )
    {
        if (!conversationId)
        {
            return null;
        }


        try
        {
            const raw =
                sessionStorage.getItem(
                    getRecoveryKey(
                        conversationId
                    )
                );


            if (!raw)
            {
                return null;
            }


            return JSON.parse(
                raw
            );
        }
        catch (error)
        {
            console.error(
                "[ChatGPT Sync] Could not load recovery draft:",
                error
            );

            return null;
        }
    }


    function clearRecovery(
        conversationId
    )
    {
        if (!conversationId)
        {
            return;
        }


        try
        {
            sessionStorage.removeItem(
                getRecoveryKey(
                    conversationId
                )
            );


            console.log(
                "[ChatGPT Sync] Recovery draft cleared.",
                {
                    conversationId
                }
            );
        }
        catch (error)
        {
            console.error(
                "[ChatGPT Sync] Could not clear recovery draft:",
                error
            );
        }
    }


    function findComposer()
    {
        return (
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
                "textarea[placeholder]"
            )
        );
    }


    function getComposerText(
        composer
    )
    {
        if (!composer)
        {
            return "";
        }


        if (
            composer instanceof
            HTMLTextAreaElement
        )
        {
            return (
                composer.value ??
                ""
            ).trim();
        }


        return (
            composer.innerText ??
            composer.textContent ??
            ""
        ).trim();
    }


    function restoreComposerText(
        composer,
        text
    )
    {
        if (
            !composer ||
            !text
        )
        {
            return false;
        }


        /*
         * Never overwrite a draft that ChatGPT has already
         * restored itself.
         */
        if (
            getComposerText(
                composer
            )
        )
        {
            return false;
        }


        composer.focus();


        if (
            composer instanceof
            HTMLTextAreaElement
        )
        {
            const valueSetter =
                Object.getOwnPropertyDescriptor(
                    HTMLTextAreaElement.prototype,
                    "value"
                )?.set;


            if (valueSetter)
            {
                valueSetter.call(
                    composer,
                    text
                );
            }
            else
            {
                composer.value =
                    text;
            }


            composer.dispatchEvent(
                new Event(
                    "input",
                    {
                        bubbles:
                            true
                    }
                )
            );


            return true;
        }


        const selection =
            window.getSelection();

        const range =
            document.createRange();


        const emptyParagraph =
            composer.querySelector(
                ":scope > p"
            );


        if (emptyParagraph)
        {
            range.selectNodeContents(
                emptyParagraph
            );

            range.collapse(
                true
            );
        }
        else
        {
            range.selectNodeContents(
                composer
            );

            range.collapse(
                false
            );
        }


        selection?.removeAllRanges();

        selection?.addRange(
            range
        );


        return document.execCommand(
            "insertText",
            false,
            text
        );
    }


    function wait(
        milliseconds
    )
    {
        return new Promise(
            resolve =>
            {
                setTimeout(
                    resolve,
                    milliseconds
                );
            }
        );
    }


    async function restoreComposerTextThroughVerifiedDomFallback(
        text,
        semanticError,
        timeoutMilliseconds = 15000,
        stabilityMilliseconds = 1500,
        pollMilliseconds = 100
    )
    {
        const expectedText =
            text.trim();

        const startedAt =
            performance.now();

        const deadline =
            startedAt +
            timeoutMilliseconds;

        let attempt = 0;
        let stableComposer = null;
        let stableSince = null;
        let lastWrittenComposer = null;
        let lastObservedText = null;


        while (
            performance.now() <
            deadline
        )
        {
            const composer =
                findComposer();

            const elapsedMs =
                Math.round(
                    performance.now() -
                    startedAt
                );


            if (!composer)
            {
                if (stableComposer)
                {
                    console.warn(
                        "[ChatGPT Sync] DOM recovery composer disappeared during verification.",
                        {
                            attempt,
                            elapsedMs
                        }
                    );
                }

                stableComposer = null;
                stableSince = null;
                lastWrittenComposer = null;
                lastObservedText = null;

                await wait(
                    pollMilliseconds
                );

                continue;
            }


            const observedText =
                getComposerText(
                    composer
                );


            if (
                observedText ===
                expectedText
            )
            {
                if (
                    stableComposer !==
                    composer
                )
                {
                    if (stableComposer)
                    {
                        console.warn(
                            "[ChatGPT Sync] DOM recovery composer was replaced during verification.",
                            {
                                attempt,
                                elapsedMs,
                                composerReplaced: true,
                                observedText
                            }
                        );
                    }

                    stableComposer =
                        composer;

                    stableSince =
                        performance.now();

                    console.log(
                        "[ChatGPT Sync] Recovered text observed in current composer; verifying stability.",
                        {
                            attempt,
                            elapsedMs,
                            observedText
                        }
                    );
                }


                if (
                    performance.now() -
                    stableSince >=
                    stabilityMilliseconds
                )
                {
                    console.log(
                        "[ChatGPT Sync] Recovery draft restored through verified DOM fallback.",
                        {
                            text,
                            semanticError:
                                semanticError ??
                                null,
                            attempt,
                            elapsedMs,
                            stabilityMilliseconds
                        }
                    );

                    return {
                        success: true,
                        attempt,
                        elapsedMs
                    };
                }


                await wait(
                    pollMilliseconds
                );

                continue;
            }


            if (observedText)
            {
                console.warn(
                    "[ChatGPT Sync] DOM recovery stopped because the composer contains different text.",
                    {
                        attempt,
                        elapsedMs,
                        observedText
                    }
                );

                return {
                    success: false,
                    conflict: true,
                    attempt,
                    elapsedMs,
                    observedText
                };
            }


            if (
                stableComposer ||
                (
                    lastWrittenComposer &&
                    lastObservedText ===
                    expectedText
                )
            )
            {
                console.warn(
                    "[ChatGPT Sync] Recovered text did not survive DOM verification; retrying current composer.",
                    {
                        attempt,
                        elapsedMs,
                        composerReplaced:
                            Boolean(
                                lastWrittenComposer &&
                                lastWrittenComposer !==
                                composer
                            ),
                        observedText
                    }
                );
            }


            stableComposer = null;
            stableSince = null;

            attempt++;

            console.log(
                "[ChatGPT Sync] DOM recovery attempt.",
                {
                    attempt,
                    elapsedMs,
                    composerReplaced:
                        Boolean(
                            lastWrittenComposer &&
                            lastWrittenComposer !==
                            composer
                        ),
                    observedText
                }
            );


            const restored =
                restoreComposerText(
                    composer,
                    text
                );

            lastWrittenComposer =
                composer;

            lastObservedText =
                restored
                    ? expectedText
                    : observedText;


            if (!restored)
            {
                const currentText =
                    getComposerText(
                        composer
                    );

                if (
                    currentText &&
                    currentText !==
                    expectedText
                )
                {
                    console.warn(
                        "[ChatGPT Sync] DOM recovery stopped rather than overwrite different composer text.",
                        {
                            attempt,
                            elapsedMs,
                            observedText:
                                currentText
                        }
                    );

                    return {
                        success: false,
                        conflict: true,
                        attempt,
                        elapsedMs,
                        observedText:
                            currentText
                    };
                }
            }


            await wait(
                pollMilliseconds
            );
        }


        const currentComposer =
            findComposer();

        const observedText =
            getComposerText(
                currentComposer
            );

        console.error(
            "[ChatGPT Sync] Recovery draft could not be durably restored through DOM fallback.",
            {
                semanticError:
                    semanticError ??
                    null,
                attempt,
                elapsedMs:
                    Math.round(
                        performance.now() -
                        startedAt
                    ),
                observedText
            }
        );

        return {
            success: false,
            conflict: false,
            attempt,
            observedText
        };
    }


    function waitForComposer(
        timeoutMilliseconds = 15000
    )
    {
        return new Promise(
            resolve =>
            {
                const existing =
                    findComposer();


                if (existing)
                {
                    resolve(
                        existing
                    );

                    return;
                }


                let completed =
                    false;


                const finish =
                    composer =>
                    {
                        if (completed)
                        {
                            return;
                        }


                        completed =
                            true;

                        observer.disconnect();

                        clearTimeout(
                            timeout
                        );

                        resolve(
                            composer
                        );
                    };


                const observer =
                    new MutationObserver(
                        () =>
                        {
                            const composer =
                                findComposer();


                            if (composer)
                            {
                                finish(
                                    composer
                                );
                            }
                        }
                    );


                observer.observe(
                    document.documentElement,
                    {
                        childList:
                            true,

                        subtree:
                            true
                    }
                );


                const timeout =
                    setTimeout(
                        () =>
                        {
                            finish(
                                null
                            );
                        },
                        timeoutMilliseconds
                    );
            }
        );
    }


    function getComposerContainer()
    {
        const composer =
            findComposer();


        if (!composer)
        {
            return null;
        }


        return (
            composer.closest(
                "form"
            ) ??
            composer
        );
    }


    function positionChatGptSyncElement(
        element
    )
    {
        if (!element?.isConnected)
        {
            return;
        }


        const viewportWidth =
            window.visualViewport?.width ??
            window.innerWidth;

        const viewportHeight =
            window.visualViewport?.height ??
            window.innerHeight;

        const viewportOffsetLeft =
            window.visualViewport?.offsetLeft ??
            0;

        const viewportOffsetTop =
            window.visualViewport?.offsetTop ??
            0;

        const sideMargin =
            viewportWidth <= 600
                ? 8
                : 16;

        const gap =
            10;

        const composer =
            getComposerContainer();

        const composerRect =
            composer?.getBoundingClientRect();


        const horizontalCentre =
            composerRect &&
            composerRect.width > 0
                ? composerRect.left +
                    composerRect.width / 2
                : viewportOffsetLeft +
                    viewportWidth / 2;


        element.style.left =
            Math.min(
                viewportOffsetLeft +
                    viewportWidth -
                    sideMargin,
                Math.max(
                    viewportOffsetLeft +
                        sideMargin,
                    horizontalCentre
                )
            ) +
            "px";

        element.style.maxWidth =
            "560px";

        element.style.width =
            "calc(100% - " +
            sideMargin * 2 +
            "px)";


        let bottom =
            16;


        if (
            composerRect &&
            composerRect.top > 0 &&
            composerRect.top < viewportOffsetTop + viewportHeight
        )
        {
            bottom =
                Math.max(
                    8,
                    viewportOffsetTop +
                    viewportHeight -
                    composerRect.top +
                    gap
                );
        }


        element.style.bottom =
            bottom +
            "px";
    }


    function scheduleResponsiveUiPosition()
    {
        if (responsiveUiFrameId !== null)
        {
            return;
        }


        responsiveUiFrameId =
            requestAnimationFrame(
                () =>
                {
                    responsiveUiFrameId =
                        null;


                    positionChatGptSyncElement(
                        document.getElementById(
                            BANNER_ID
                        )
                    );

                    positionChatGptSyncElement(
                        document.getElementById(
                            RECOVERY_STATUS_ID
                        )
                    );
                }
            );
    }


    function isVisibleElement(
        element
    )
    {
        if (!element?.isConnected)
        {
            return false;
        }


        const style =
            getComputedStyle(
                element
            );


        return (
            style.display !== "none" &&
            style.visibility !== "hidden"
        );
    }


    function suppressBlockedSendRetryButtons()
    {
        if (syncState !== "blocked-send")
        {
            return;
        }


        const ownBanner =
            document.getElementById(
                BANNER_ID
            );


        for (
            const button of
            document.querySelectorAll(
                "button"
            )
        )
        {
            if (
                ownBanner?.contains(
                    button
                )
            )
            {
                continue;
            }


            if (
                button.textContent?.trim() !==
                "Retry"
            )
            {
                continue;
            }


            if (!isVisibleElement(button))
            {
                continue;
            }


            /*
             * Only suppress Retry controls rendered close to
             * ChatGPT's native failed-send/error UI. Never
             * globally hide unrelated Retry buttons.
             */
            const isThreadErrorRetry =
                button.matches(
                    'button[data-testid="regenerate-thread-error-button"]'
                );

            const container =
                isThreadErrorRetry
                    ? button.parentElement
                    : (
                        button.closest(
                            '[role="alert"], [class*="error"]'
                        ) ??
                        button.parentElement
                    );


            const text =
                container?.textContent ??
                "";


            if (
                text.includes(
                    "ChatGPT Sync blocked this message"
                ) ||
                text.includes(
                    "conversation is out of sync"
                )
            )
            {
                button.style.display =
                    "none";

                button.setAttribute(
                    "data-chatgpt-sync-native-retry-suppressed",
                    "true"
                );
            }
        }
    }


    function startBlockedSendUiGuard()
    {
        blockedSendUiObserver?.disconnect();


        suppressBlockedSendRetryButtons();


        blockedSendUiObserver =
            new MutationObserver(
                () =>
                {
                    suppressBlockedSendRetryButtons();
                    scheduleResponsiveUiPosition();
                }
            );


        blockedSendUiObserver.observe(
            document.documentElement,
            {
                childList:
                    true,

                subtree:
                    true
            }
        );
    }


    function stopBlockedSendUiGuard()
    {
        blockedSendUiObserver?.disconnect();

        blockedSendUiObserver =
            null;
    }


    function removeBanner()
    {
        document
            .getElementById(
                BANNER_ID
            )
            ?.remove();
    }


    function setRecoverySendLock(
        locked
    )
    {
        if (locked)
        {
            document.documentElement.setAttribute(
                RECOVERY_LOCK_ATTRIBUTE,
                "true"
            );

            return;
        }

        document.documentElement.removeAttribute(
            RECOVERY_LOCK_ATTRIBUTE
        );
    }


    function logRecoveryUi(
        message,
        details = {}
    )
    {
        console.log(
            "[ChatGPT Sync] " + message,
            {
                documentInstanceId:
                    DOCUMENT_INSTANCE_ID,

                ...details
            }
        );
    }


    function mountRecoveryStatus(
        remount = false
    )
    {
        const state =
            recoveryStatusState;

        if (!state)
        {
            return;
        }

        const existing =
            document.getElementById(
                RECOVERY_STATUS_ID
            );

        if (existing?.isConnected)
        {
            state.status =
                existing;

            return;
        }

        (
            document.body ??
            document.documentElement
        ).appendChild(
            state.status
        );

        positionChatGptSyncElement(
            state.status
        );

        logRecoveryUi(
            remount
                ? "Recovery UI remounted."
                : "Recovery UI mounted.",
            {
                attachmentCount:
                    state.attachmentCount,

                elapsedMs:
                    Date.now() - state.startedAt
            }
        );
    }


    function ensureRecoveryStatusMounted()
    {
        const state =
            recoveryStatusState;

        if (
            !state ||
            state.status.isConnected
        )
        {
            return;
        }

        logRecoveryUi(
            "Recovery UI detached from DOM.",
            {
                attachmentCount:
                    state.attachmentCount,

                elapsedMs:
                    Date.now() - state.startedAt
            }
        );

        mountRecoveryStatus(
            true
        );
    }


    function removeRecoveryStatus(
        reason = "explicit-clear"
    )
    {
        if (recoveryStatusIntervalId !== null)
        {
            clearInterval(
                recoveryStatusIntervalId
            );

            recoveryStatusIntervalId =
                null;
        }

        if (recoveryStatusObserver !== null)
        {
            recoveryStatusObserver.disconnect();

            recoveryStatusObserver =
                null;
        }

        const status =
            recoveryStatusState?.status ??
            document.getElementById(
                RECOVERY_STATUS_ID
            );

        if (status)
        {
            status.remove();
        }

        if (recoveryStatusState)
        {
            logRecoveryUi(
                "Recovery UI cleared.",
                {
                    reason,
                    elapsedMs:
                        Date.now() - recoveryStatusState.startedAt
                }
            );
        }

        recoveryStatusState =
            null;
    }


    function isChatGptDarkTheme()
    {
        const html =
            document.documentElement;

        const body =
            document.body;

        const explicitTheme =
            html?.getAttribute(
                "data-theme"
            ) ??
            body?.getAttribute(
                "data-theme"
            );


        if (explicitTheme === "dark")
        {
            return true;
        }


        if (explicitTheme === "light")
        {
            return false;
        }


        if (
            html?.classList.contains(
                "dark"
            ) ||
            body?.classList.contains(
                "dark"
            )
        )
        {
            return true;
        }


        if (
            html?.classList.contains(
                "light"
            ) ||
            body?.classList.contains(
                "light"
            )
        )
        {
            return false;
        }


        return window.matchMedia?.(
            "(prefers-color-scheme: dark)"
        ).matches ?? false;
    }


    function applyChatGptSyncTheme(
        element
    )
    {
        if (!element)
        {
            return;
        }


        const dark =
            isChatGptDarkTheme();


        element.style.background =
            dark
                ? "#212121"
                : "#ffffff";

        element.style.color =
            dark
                ? "#f5f5f5"
                : "#0d0d0d";

        element.style.borderColor =
            dark
                ? "rgba(255, 255, 255, 0.16)"
                : "rgba(0, 0, 0, 0.16)";

        element.style.boxShadow =
            dark
                ? "0 8px 30px rgba(0, 0, 0, 0.42)"
                : "0 8px 30px rgba(0, 0, 0, 0.18)";


        for (
            const button of
            element.querySelectorAll(
                "button"
            )
        )
        {
            button.style.background =
                dark
                    ? "#2f2f2f"
                    : "#f7f7f7";

            button.style.color =
                dark
                    ? "#f5f5f5"
                    : "#0d0d0d";

            button.style.borderColor =
                dark
                    ? "rgba(255, 255, 255, 0.20)"
                    : "rgba(0, 0, 0, 0.18)";
        }
    }


    function watchChatGptSyncTheme(
        element
    )
    {
        applyChatGptSyncTheme(
            element
        );


        const observer =
            new MutationObserver(
                () =>
                {
                    if (!element.isConnected)
                    {
                        observer.disconnect();
                        return;
                    }


                    applyChatGptSyncTheme(
                        element
                    );
                }
            );

        const options =
        {
            attributes:
                true,

            attributeFilter:
            [
                "class",
                "data-theme"
            ]
        };


        observer.observe(
            document.documentElement,
            options
        );


        if (document.body)
        {
            observer.observe(
                document.body,
                options
            );
        }


        const colourScheme =
            window.matchMedia?.(
                "(prefers-color-scheme: dark)"
            );

        colourScheme?.addEventListener?.(
            "change",
            () =>
            {
                if (element.isConnected)
                {
                    applyChatGptSyncTheme(
                        element
                    );
                }
            },
            {
                once:
                    true
            }
        );
    }


    function showRecoveryStatus(
        attachmentCount
    )
    {
        removeRecoveryStatus(
            "replace"
        );

        const startedAt =
            Date.now();

        const spinnerFrames =
            [
                "◐",
                "◓",
                "◑",
                "◒"
            ];

        let spinnerFrame =
            0;

        const status =
            document.createElement(
                "div"
            );

        status.id =
            RECOVERY_STATUS_ID;

        Object.assign(
            status.style,
            {
                position:
                    "fixed",

                left:
                    "50%",

                bottom:
                    "16px",

                transform:
                    "translateX(-50%)",

                zIndex:
                    "2147483647",

                maxWidth:
                    "560px",

                width:
                    "calc(100% - 32px)",

                boxSizing:
                    "border-box",

                padding:
                    "12px 14px",

                border:
                    "1px solid rgba(127, 127, 127, 0.35)",

                borderRadius:
                    "12px",

                background:
                    "#ffffff",

                color:
                    "#0d0d0d",

                boxShadow:
                    "0 8px 30px rgba(0, 0, 0, 0.18)",

                fontFamily:
                    "system-ui, sans-serif",

                fontSize:
                    "14px",

                lineHeight:
                    "1.4"
            }
        );

        const title =
            document.createElement(
                "div"
            );

        title.style.fontWeight =
            "600";

        const detail =
            document.createElement(
                "div"
            );

        detail.style.marginTop =
            "3px";

        const progress =
            document.createElement(
                "div"
            );

        progress.style.marginTop =
            "6px";

        progress.style.fontVariantNumeric =
            "tabular-nums";

        const updateStatus =
            () =>
            {
                const elapsedSeconds =
                    Math.floor(
                        (Date.now() - startedAt) / 1000
                    );

                title.textContent =
                    spinnerFrames[spinnerFrame] +
                    " Restoring your message…";

                spinnerFrame =
                    (spinnerFrame + 1) % spinnerFrames.length;

                detail.textContent =
                    attachmentCount > 0
                        ? "Waiting for ChatGPT to finish loading before restoring " +
                            attachmentCount +
                            (attachmentCount === 1 ? " attachment. " : " attachments. ") +
                            "Sending is temporarily disabled."
                        : "Waiting for ChatGPT to finish loading before restoring your message.";

                progress.textContent =
                    elapsedSeconds >= 15
                        ? "Still working — " + elapsedSeconds +
                            " seconds elapsed. ChatGPT is still finishing loading; waits of 90–120 seconds are common."
                        : "Still working — " + elapsedSeconds +
                            (elapsedSeconds === 1 ? " second elapsed." : " seconds elapsed.");
            };

        updateStatus();

        status.append(
            title,
            detail,
            progress
        );

        watchChatGptSyncTheme(
            status
        );

        recoveryStatusState =
            {
                attachmentCount,
                startedAt,
                status
            };

        mountRecoveryStatus();

        recoveryStatusObserver =
            new MutationObserver(
                () =>
                {
                    ensureRecoveryStatusMounted();
                }
            );

        recoveryStatusObserver.observe(
            document.documentElement,
            {
                childList:
                    true,

                subtree:
                    true
            }
        );

        recoveryStatusIntervalId =
            setInterval(
                () =>
                {
                    updateStatus();
                    ensureRecoveryStatusMounted();
                },
                1000
            );
    }


    function clearVerificationBannerTimer()
    {
        if (
            verificationBannerIntervalId !==
            null
        )
        {
            clearInterval(
                verificationBannerIntervalId
            );

            verificationBannerIntervalId =
                null;
        }
    }


    function formatRetryTime(
        retryAt
    )
    {
        const date =
            new Date(
                retryAt
            );


        if (
            Number.isNaN(
                date.getTime()
            )
        )
        {
            return "the indicated retry time";
        }


        return date.toLocaleTimeString(
            [],
            {
                hour:
                    "2-digit",

                minute:
                    "2-digit",

                second:
                    "2-digit"
            }
        );
    }


    function showStateVerificationWaiting(
        eventData
    )
    {
        clearVerificationBannerTimer();


        const banner =
            createBanner(
                "",
                null,
                {
                    buttonText:
                        null
                }
            );

        const message =
            banner.querySelector(
                "[data-chatgpt-sync-banner-message]"
            );

        const retryAtMs =
            Date.parse(
                eventData.retryAt
            );


        const update =
            () =>
            {
                const remainingSeconds =
                    Math.max(
                        0,
                        Math.ceil(
                            (retryAtMs - Date.now()) /
                            1000
                        )
                    );

                const elapsedSeconds =
                    Math.max(
                        0,
                        Math.floor(
                            (
                                eventData.elapsedMs +
                                (
                                    eventData.delayMs -
                                    Math.max(
                                        retryAtMs - Date.now(),
                                        0
                                    )
                                )
                            ) / 1000
                        )
                    );

                const elapsedMinutes =
                    Math.floor(
                        elapsedSeconds / 60
                    );

                const elapsedRemainderSeconds =
                    elapsedSeconds % 60;

                message.textContent =
                    "ChatGPT Sync could not verify that this conversation is up to date. " +
                    "Your message has not been sent. Waiting " +
                    remainingSeconds +
                    (remainingSeconds === 1 ? " second" : " seconds") +
                    " before retrying automatically. Elapsed: " +
                    elapsedMinutes +
                    "m " +
                    elapsedRemainderSeconds +
                    "s; automatic retries continue for up to 5 minutes.";
            };


        update();

        verificationBannerIntervalId =
            setInterval(
                update,
                250
            );
    }


    function showStateVerificationFailed(
        eventData
    )
    {
        clearVerificationBannerTimer();


        const retryTime =
            formatRetryTime(
                eventData.retryAt
            );

        const banner =
            createBanner(
                "ChatGPT Sync could not verify that this conversation is up to date, " +
                "so your message was not sent. Copy your message to the clipboard, " +
                "manually reload the conversation, and retry after " +
                retryTime +
                ".",
                null,
                {
                    buttonText:
                        "Copy message",

                    onButtonClick:
                        async button =>
                        {
                            const text =
                                eventData.messageText ??
                                "";

                            try
                            {
                                await navigator.clipboard.writeText(
                                    text
                                );

                                button.textContent =
                                    "Copied";
                            }
                            catch (error)
                            {
                                console.error(
                                    "[ChatGPT Sync] Could not copy blocked message to clipboard.",
                                    error
                                );

                                button.textContent =
                                    "Copy failed";
                            }
                        }
                }
            );


        return banner;
    }


    function createBanner(
        messageText,
        recovery = null,
        options = {}
    )
    {
        removeBanner();


        const banner =
            document.createElement(
                "div"
            );

        banner.id =
            BANNER_ID;


        Object.assign(
            banner.style,
            {
                position:
                    "fixed",

                left:
                    "50%",

                bottom:
                    "16px",

                transform:
                    "translateX(-50%)",

                zIndex:
                    "2147483647",

                display:
                    "flex",

                alignItems:
                    "center",

                gap:
                    "12px",

                maxWidth:
                    "560px",

                width:
                    "calc(100% - 32px)",

                boxSizing:
                    "border-box",

                flexWrap:
                    "wrap",

                padding:
                    "12px 14px",

                border:
                    "1px solid rgba(127, 127, 127, 0.35)",

                borderRadius:
                    "12px",

                background:
                    "#ffffff",

                color:
                    "#0d0d0d",

                boxShadow:
                    "0 8px 30px rgba(0, 0, 0, 0.18)",

                fontFamily:
                    "system-ui, sans-serif",

                fontSize:
                    "14px"
            }
        );


        const message =
            document.createElement(
                "div"
            );

        message.textContent =
            messageText;

        Object.assign(
            message.style,
            {
                flex:
                    "1 1 280px",

                minWidth:
                    "0"
            }
        );

        message.setAttribute(
            "data-chatgpt-sync-banner-message",
            "true"
        );


        const buttonText =
            Object.prototype.hasOwnProperty.call(
                options,
                "buttonText"
            )
                ? options.buttonText
                : "Sync conversation";

        const button =
            buttonText === null
                ? null
                : document.createElement(
                    "button"
                );


        if (button)
        {
            button.type =
                "button";

            button.textContent =
                buttonText;
        }


        if (button)
        {
            Object.assign(
                button.style,
                {
                    flex:
                        "0 0 auto",

                    padding:
                        "8px 12px",

                    border:
                        "1px solid rgba(127, 127, 127, 0.35)",

                    borderRadius:
                        "8px",

                    cursor:
                        "pointer",

                    font:
                        "inherit",

                    fontWeight:
                        "600"
                }
            );


            button.addEventListener(
                "click",
                async () =>
                {
                    if (
                        typeof options.onButtonClick ===
                        "function"
                    )
                    {
                        await options.onButtonClick(
                            button
                        );

                        return;
                    }


                    /*
                     * Persist once more immediately before the
                     * reload.
                     */
                    if (
                        recovery?.text ||
                        recovery?.message
                    )
                    {
                        saveRecovery(
                            recovery
                        );
                    }


                    button.disabled =
                        true;

                    button.textContent =
                        "Syncing…";


                    window.location.reload();
                }
            );
        }


        banner.append(
            message
        );


        if (button)
        {
            banner.append(
                button
            );
        }


        watchChatGptSyncTheme(
            banner
        );


        (
            document.body ??
            document.documentElement
        ).appendChild(
            banner
        );

        positionChatGptSyncElement(
            banner
        );


        return banner;
    }


    function showEarlyWarning()
    {
        createBanner(
            "This conversation changed elsewhere. " +
            "Sync before continuing to make sure you're " +
            "replying to the latest messages."
        );
    }


    function showBlockedSendWarning(
        recovery
    )
    {
        createBanner(
            "This conversation changed elsewhere. " +
            "Your message was protected and was not sent " +
            "against the outdated conversation.",
            recovery
        );
    }


    function canAutoSyncNow()
    {
        const composer =
            findComposer();


        if (!composer)
        {
            return true;
        }


        return (
            getComposerText(
                composer
            ) ===
            ""
        );
    }


    function transitionToStale(
        staleState
    )
    {
        /*
         * Once a real user send has been blocked, later
         * background stale notifications cannot downgrade
         * the recovery state.
         */
        if (
            syncState ===
            "blocked-send"
        )
        {
            console.log(
                "[ChatGPT Sync] Ignoring stale background " +
                "notification because a blocked send is " +
                "already being recovered."
            );


            return false;
        }


        syncState =
            "stale";

        knownStaleConversationId =
            staleState.conversationId;


        /*
         * This is a normal operating state, not a browser
         * extension warning.
         */
        console.log(
            "[ChatGPT Sync] State transition: healthy/stale -> stale.",
            {
                conversationId:
                    staleState.conversationId,

                mode:
                    MODE
            }
        );


        return true;
    }


    function transitionToBlockedSend(
        recovery
    )
    {
        syncState =
            "blocked-send";

        knownStaleConversationId =
            recovery.conversationId;


        /*
         * Deliberately blocking a stale send is successful
         * extension behaviour, so log rather than warn.
         */
        console.log(
            "[ChatGPT Sync] State transition: -> blocked-send.",
            {
                conversationId:
                    recovery.conversationId,

                text:
                    recovery.text,

                messageId:
                    recovery.messageId ??
                    null
            }
        );
    }


    function handleStaleDetected(
        staleState
    )
    {
        if (
            !staleState?.conversationId
        )
        {
            return;
        }


        const transitioned =
            transitionToStale(
                staleState
            );


        if (!transitioned)
        {
            return;
        }


        if (
            MODE ===
            "warn-early"
        )
        {
            showEarlyWarning();

            return;
        }


        /*
         * ON-SEND MODE
         *
         * Remember the stale state, but deliberately show
         * no user-facing UI until a genuine user send is
         * attempted.
         */
        if (
            MODE ===
            "on-send"
        )
        {
            console.log(
                "[ChatGPT Sync] Conversation is stale; " +
                "on-send mode is deferring user-facing UI " +
                "until a genuine send is attempted.",
                {
                    conversationId:
                        staleState.conversationId
                }
            );


            return;
        }


        if (
            MODE ===
            "auto-sync"
        )
        {
            if (
                canAutoSyncNow()
            )
            {
                console.log(
                    "[ChatGPT Sync] Auto-syncing stale conversation."
                );


                window.location.reload();

                return;
            }


            console.log(
                "[ChatGPT Sync] Auto-sync deferred because " +
                "the composer contains a draft."
            );
        }
    }


    function handleBlockedSend(
        recovery
    )
    {
        if (
            !recovery?.conversationId
        )
        {
            return;
        }


        transitionToBlockedSend(
            recovery
        );

        startBlockedSendUiGuard();


        if (
            recovery.text ||
            recovery.message
        )
        {
            saveRecovery(
                recovery
            );
        }


        showBlockedSendWarning(
            recovery
        );
    }


    function getMessageAttachmentSignature(
        message
    )
    {
        const attachments = message?.metadata?.attachments;

        if (!Array.isArray(attachments))
        {
            return [];
        }

        return attachments.map(attachment => ({
            id: attachment?.id ?? null,
            libraryFileId:
                attachment?.library_file_id ?? null,
            mimeType:
                attachment?.mime_type ?? null,
            name:
                attachment?.name ?? null,
            size:
                attachment?.size ?? null
        }));
    }


    function sameAttachmentComposition(
        leftMessage,
        rightMessage
    )
    {
        const left = getMessageAttachmentSignature(leftMessage);
        const right = getMessageAttachmentSignature(rightMessage);

        if (left.length !== right.length)
        {
            return false;
        }

        return left.every((attachment, index) =>
            JSON.stringify(attachment) ===
                JSON.stringify(right[index])
        );
    }


    function recoveryHasAttachments(
        recovery
    )
    {
        return getMessageAttachmentSignature(
            recovery?.message
        ).length > 0;
    }


    const pendingAttachmentRestoreRequests =
        new Map();

    const pendingComposerTextRestoreRequests =
        new Map();


    function requestComposerTextRestore(
        recovery,
        timeoutMilliseconds = 20000
    )
    {
        return new Promise(resolve =>
        {
            const requestId = crypto.randomUUID();

            const timeout = setTimeout(
                () =>
                {
                    pendingComposerTextRestoreRequests.delete(
                        requestId
                    );

                    resolve({
                        success: false,
                        error: "Composer text restoration timed out."
                    });
                },
                timeoutMilliseconds
            );

            pendingComposerTextRestoreRequests.set(
                requestId,
                result =>
                {
                    clearTimeout(timeout);
                    resolve(result);
                }
            );

            window.postMessage(
                {
                    source: MESSAGE_SOURCE,
                    type: "restore-recovery-composer-text",
                    requestId,
                    conversationId:
                        recovery.conversationId,
                    text:
                        recovery.text
                },
                window.location.origin
            );
        });
    }


    function requestAttachmentRestore(
        recovery,
        timeoutMilliseconds = 310000
    )
    {
        return new Promise(resolve =>
        {
            const requestId = crypto.randomUUID();

            const timeout = setTimeout(
                () =>
                {
                    pendingAttachmentRestoreRequests.delete(
                        requestId
                    );

                    resolve({
                        success: false,
                        error: "Attachment restoration timed out."
                    });
                },
                timeoutMilliseconds
            );

            pendingAttachmentRestoreRequests.set(
                requestId,
                result =>
                {
                    clearTimeout(timeout);
                    resolve(result);
                }
            );

            window.postMessage(
                {
                    source: MESSAGE_SOURCE,
                    type: "restore-recovery-attachments",
                    requestId,
                    conversationId:
                        recovery.conversationId,
                    message:
                        recovery.message ?? null
                },
                window.location.origin
            );
        });
    }


    /*
     * Determine whether an accepted user message corresponds
     * to the recovery record that we are holding.
     *
     * Prefer message ID where possible because it is more
     * precise than text comparison.
     *
     * However, ChatGPT may create a fresh message ID when a
     * recovered draft is manually re-submitted. Therefore
     * exact text remains the fallback identity check.
     */
    function acceptedSendMatchesRecovery(
        acceptedSend,
        recovery
    )
    {
        if (!acceptedSend || !recovery)
        {
            return false;
        }

        if (
            acceptedSend.conversationId !==
                recovery.conversationId
        )
        {
            return false;
        }

        /*
         * A recovered multimodal message must be accepted with the
         * same attachment composition. Text equality alone is never
         * sufficient for a recovery that contained attachments.
         */
        if (recoveryHasAttachments(recovery))
        {
            if (
                !sameAttachmentComposition(
                    acceptedSend.message,
                    recovery.message
                )
            )
            {
                return false;
            }

            return (
                typeof acceptedSend.text === "string" &&
                typeof recovery.text === "string" &&
                acceptedSend.text === recovery.text
            );
        }

        if (
            acceptedSend.messageId &&
            recovery.messageId &&
            acceptedSend.messageId === recovery.messageId
        )
        {
            return true;
        }

        return (
            typeof acceptedSend.text === "string" &&
            typeof recovery.text === "string" &&
            acceptedSend.text === recovery.text
        );
    }

    function handleSendAccepted(
        acceptedSend
    )
    {
        if (
            !acceptedSend?.conversationId
        )
        {
            return;
        }


        const recovery =
            loadRecovery(
                acceptedSend.conversationId
            );


        /*
         * Most successful sends have nothing to do with a
         * recovery workflow.
         */
        if (!recovery)
        {
            console.log(
                "[ChatGPT Sync] Send accepted. " +
                "No recovery record requires cleanup.",
                {
                    conversationId:
                        acceptedSend.conversationId,

                    text:
                        acceptedSend.text,

                    messageId:
                        acceptedSend.messageId ??
                        null
                }
            );


            return;
        }


        /*
         * Never delete a recovery merely because some other
         * message was successfully sent in the conversation.
         */
        if (
            !acceptedSendMatchesRecovery(
                acceptedSend,
                recovery
            )
        )
        {
            console.log(
                "[ChatGPT Sync] Send accepted, but it does not " +
                "match the stored recovery. Recovery retained.",
                {
                    acceptedText:
                        acceptedSend.text,

                    recoveryText:
                        recovery.text,

                    acceptedMessageId:
                        acceptedSend.messageId ??
                        null,

                    recoveryMessageId:
                        recovery.messageId ??
                        null
                }
            );


            return;
        }


        /*
         * Make the successful identity check explicit before
         * deleting the safety copy.
         */
        console.log(
            "[ChatGPT Sync] Accepted send matches stored recovery.",
            {
                conversationId:
                    acceptedSend.conversationId,

                text:
                    acceptedSend.text,

                acceptedMessageId:
                    acceptedSend.messageId ??
                    null,

                recoveryMessageId:
                    recovery.messageId ??
                    null
            }
        );


        clearRecovery(
            acceptedSend.conversationId
        );


        syncState =
            "healthy";

        knownStaleConversationId =
            null;

        stopBlockedSendUiGuard();

        removeBanner();


        console.log(
            "[ChatGPT Sync] Recovery lifecycle complete.",
            {
                conversationId:
                    acceptedSend.conversationId,

                text:
                    acceptedSend.text
            }
        );
    }


    async function recoverAfterReload()
    {
        const conversationId =
            getCurrentConversationId();

        if (!conversationId)
        {
            return;
        }

        const recovery =
            loadRecovery(conversationId);

        if (
            !recovery ||
            (
                !recovery.text &&
                !recovery.message
            )
        )
        {
            return;
        }

        const attachmentCount =
            getMessageAttachmentSignature(
                recovery.message
            ).length;

        /*
         * Make every pending recovery visible immediately. Text-only
         * recovery can still spend time waiting for the composer or the
         * semantic restoration path, so it should not appear to have
         * stalled just because there are no attachments.
         */
        showRecoveryStatus(
            attachmentCount
        );

        if (attachmentCount > 0)
        {
            /*
             * The page can look fully loaded while ChatGPT is still
             * settling the conversation model used to validate recovered
             * attachments. Prevent a genuine user send until attachment
             * recovery has completed.
             *
             * The DOM attribute is intentionally used as the cross-world
             * lock: the page-context interceptor can read it synchronously
             * on the outgoing fetch path.
             */
            setRecoverySendLock(
                true
            );
        }

        const composer =
            await waitForComposer();

        if (!composer)
        {
            console.error(
                "[ChatGPT Sync] Recovery exists, " +
                "but the composer could not be found."
            );

            removeRecoveryStatus(
                "recovery-failed"
            );
            setRecoverySendLock(
                false
            );

            return;
        }

        let attachmentRestoreSucceeded = true;
        let textRestoreSucceeded =
            !recovery.text;

        if (recoveryHasAttachments(recovery))
        {
            const result =
                await requestAttachmentRestore(recovery);

            attachmentRestoreSucceeded =
                Boolean(result?.success);

            if (attachmentRestoreSucceeded)
            {
                console.log(
                    "[ChatGPT Sync] Recovery attachments restored by extension.",
                    {
                        requestedCount:
                            result.requestedCount,
                        restoredCount:
                            result.restoredCount,
                        alreadyPresentCount:
                            result.alreadyPresentCount ?? 0
                    }
                );
            }
            else
            {
                console.error(
                    "[ChatGPT Sync] Recovery attachments could not be restored.",
                    result
                );
            }
        }

        const existingText =
            getComposerText(composer);

        if (existingText)
        {
            textRestoreSucceeded =
                true;

            console.log(
                "[ChatGPT Sync] ChatGPT restored the draft text itself.",
                {
                    text: existingText
                }
            );
        }
        else if (recovery.text)
        {
            const semanticResult =
                await requestComposerTextRestore(
                    recovery
                );

            if (semanticResult?.success)
            {
                textRestoreSucceeded =
                    true;

                console.log(
                    "[ChatGPT Sync] Recovery draft restored through ChatGPT composer state.",
                    {
                        text: recovery.text
                    }
                );
            }
            else
            {
                /*
                 * Compatibility fallback only. The semantic page-context
                 * callback is preferred because direct ProseMirror mutation
                 * can be overwritten by React state.
                 */
                const domFallbackResult =
                    await restoreComposerTextThroughVerifiedDomFallback(
                        recovery.text,
                        semanticResult?.error ??
                            null
                    );

                textRestoreSucceeded =
                    domFallbackResult.success;

                if (!domFallbackResult.success)
                {
                    console.error(
                        "[ChatGPT Sync] Recovery draft could not be restored.",
                        {
                            semanticResult,
                            domFallbackResult
                        }
                    );
                }
            }
        }

        removeRecoveryStatus(
            attachmentRestoreSucceeded &&
            textRestoreSucceeded
                ? "recovery-complete"
                : "recovery-failed"
        );
        setRecoverySendLock(
            false
        );

        if (!attachmentRestoreSucceeded)
        {
            createBanner(
                "Your message text was recovered, but one or more " +
                "attachments could not be restored automatically. " +
                "Please re-add the attachment before sending.",
                recovery
            );
        }
    }

    window.addEventListener(
        "message",
        event =>
        {
            if (
                event.source !==
                    window ||
                event.data?.source !==
                    MESSAGE_SOURCE
            )
            {
                return;
            }


            if (
                event.data?.type ===
                "restore-recovery-composer-text-result"
            )
            {
                const resolver =
                    pendingComposerTextRestoreRequests.get(
                        event.data.requestId
                    );

                if (resolver)
                {
                    pendingComposerTextRestoreRequests.delete(
                        event.data.requestId
                    );

                    resolver(
                        event.data.result
                    );
                }

                return;
            }


            if (
                event.data?.type ===
                "restore-recovery-attachments-result"
            )
            {
                const resolver =
                    pendingAttachmentRestoreRequests.get(
                        event.data.requestId
                    );

                if (resolver)
                {
                    pendingAttachmentRestoreRequests.delete(
                        event.data.requestId
                    );

                    resolver(
                        event.data.result
                    );
                }

                return;
            }


            if (
                event.data?.type ===
                "state-verification-waiting"
            )
            {
                showStateVerificationWaiting(
                    event.data
                );


                return;
            }


            if (
                event.data?.type ===
                "state-verification-resolved"
            )
            {
                clearVerificationBannerTimer();
                removeBanner();


                return;
            }


            if (
                event.data?.type ===
                "state-verification-failed"
            )
            {
                showStateVerificationFailed(
                    event.data
                );


                return;
            }


            if (
                event.data?.type ===
                "stale-detected"
            )
            {
                handleStaleDetected(
                    event.data.staleState
                );


                return;
            }


            if (
                event.data?.type ===
                "stale-send-blocked"
            )
            {
                handleBlockedSend(
                    event.data.recovery
                );


                return;
            }


            if (
                event.data?.type ===
                "send-accepted"
            )
            {
                handleSendAccepted(
                    event.data.acceptedSend
                );
            }
        }
    );


    window.addEventListener(
        "resize",
        scheduleResponsiveUiPosition
    );

    window.visualViewport?.addEventListener(
        "resize",
        scheduleResponsiveUiPosition
    );

    window.visualViewport?.addEventListener(
        "scroll",
        scheduleResponsiveUiPosition
    );


    injectInterceptor();


    if (
        document.readyState ===
        "loading"
    )
    {
        document.addEventListener(
            "DOMContentLoaded",
            () =>
            {
                recoverAfterReload();
            },
            {
                once:
                    true
            }
        );
    }
    else
    {
        recoverAfterReload();
    }


    console.log(
        "[ChatGPT Sync] Content script installed.",
        {
            mode:
                MODE,

            syncState,

            documentInstanceId:
                DOCUMENT_INSTANCE_ID,

            href:
                window.location.href,

            readyState:
                document.readyState
        }
    );
})();