# Mermaid browser runtime

`mermaid.min.js` is the unmodified standalone distribution from Mermaid 11.15.0
(`package/dist/mermaid.min.js`). MIT license: [mermaid.LICENSE](./mermaid.LICENSE).
Upstream: https://github.com/mermaid-js/mermaid

Source archive: `https://registry.npmjs.org/mermaid/-/mermaid-11.15.0.tgz`

Archive integrity:
`sha512-pTMbcf3rWdtLiYGpmoTjHEpeY8seiy6sR+9nD7LOs8KfUbHE4lOUAprTRqRAcWSQ6MQpdX+YEsxShtGsINtPtw==`

Vendored from the existing npm cache to honor the no-new-npm-dependencies constraint
and keep diagrams available offline. Vite emits this as an asset, fetched only by
the lazy diagram component. It is never evaluated in the application context:
an opaque iframe with strict Mermaid security and CSP isolates its output. Remote
images, network connections, navigation and access to the parent app are blocked.
