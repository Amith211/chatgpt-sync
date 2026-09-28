# Privacy Policy

**Last updated: 29 September 2026**

ChatGPT Sync is a browser extension designed to help prevent data loss caused by out-of-sync ChatGPT conversations.

This privacy policy explains what information ChatGPT Sync handles and how that information is used.

## Information handled by ChatGPT Sync

To provide its synchronisation and recovery functionality, ChatGPT Sync may process information associated with your use of ChatGPT, including:

- the content of a message that you attempt to send;
- ChatGPT conversation identifiers and conversation state;
- information associated with supported message attachments, such as file identifiers, filenames, MIME types, file sizes and dimensions; and
- information from ChatGPT network requests that is necessary to determine whether the conversation displayed in the browser is synchronised with the current conversation state held by ChatGPT.

When ChatGPT Sync prevents an out-of-sync message from being sent, information required to recover that message and its supported attachments may be temporarily stored in the browser's local or session storage.

ChatGPT Sync does not preserve the original binary contents of recovered attachments. It stores only the information necessary to reference and restore supported attachments using the existing ChatGPT attachment state.

When making a synchronisation check, ChatGPT Sync may temporarily reuse request information already provided by ChatGPT to the browser where necessary to make that request to ChatGPT. This information is used only in memory for that purpose and is not stored, logged, collected by the developer, or transmitted to the developer or any developer-operated service.

## How information is used

Information handled by ChatGPT Sync is used only to provide the extension's user-facing functionality, including:

- determining whether the currently displayed ChatGPT conversation is synchronised before allowing a message to be sent;
- preventing a message from being sent against outdated conversation state; and
- preserving and restoring a blocked message and supported attachment information following synchronisation.

## Data sharing and transmission

ChatGPT Sync does not operate a developer backend and does not transmit user information to the extension developer.

The extension communicates with ChatGPT only where necessary to provide its synchronisation functionality. Information involved in those requests is transmitted to ChatGPT using the existing secure HTTPS connection to `chatgpt.com`.

ChatGPT Sync does not sell user information, provide it to data brokers, use it for advertising or profiling, or use it to determine creditworthiness or for lending purposes.

ChatGPT Sync does not include analytics or advertising services.

## Data storage and retention

Recovery information may be temporarily stored within the user's browser so that a blocked message and supported attachments can be restored after the ChatGPT conversation has been synchronised or reloaded.

Recovery information is removed when it is no longer required by the recovery process in accordance with the extension's normal operation. Users can also remove locally stored extension data by removing the extension or clearing the relevant browser/site data.

The developer does not retain a separate copy of this information.

## Human access to user data

The developer does not receive or have access to messages, conversation contents, attachment information, or other information processed by ChatGPT Sync during normal operation.

## Chrome Web Store Limited Use

ChatGPT Sync's use of information is limited to providing its disclosed single purpose and user-facing functionality.

ChatGPT Sync's handling and use of user information complies with the Chrome Web Store User Data Policy, including the Limited Use requirements.

In particular, user information is not used or transferred for personalised advertising, advertising profiling, data brokerage, creditworthiness or lending purposes.

## Scope

ChatGPT Sync operates only on `chatgpt.com`. It does not request access to other websites.

## Changes to this policy

This policy may be updated if ChatGPT Sync's functionality or data-handling practices change. The current version will be published at this location with an updated revision date.

## Contact

Questions about this privacy policy or ChatGPT Sync can be raised through the project's GitHub repository:

https://github.com/Amith211/chatgpt-sync

## Independent project

ChatGPT Sync is an independent project and is not affiliated with or endorsed by OpenAI.