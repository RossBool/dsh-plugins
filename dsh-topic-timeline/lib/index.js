/**
 * dsh-topic-timeline — node half (host side).
 * Pure UI plugin: the empty apply exists so the plugin appears in the host
 * loader; the browser half ships via exports["./client"], discovered through
 * the package.json dsh.client declaration.
 */
function apply() {}
export { apply };
