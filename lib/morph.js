/**
 * Idiomorph wrapper — uses the global Idiomorph loaded via CDN.
 * Prevents nested custom elements from being torn down and re-created.
 */

export function morph(component, html) {
    Idiomorph.morph(component, html, {
        morphStyle: 'innerHTML',
        ignoreActiveValue: true,
        callbacks: {
            beforeNodeMorphed(oldNode, newNode) {
                if (isNestedCustomElement(oldNode, component)) {
                    syncAttributes(oldNode, newNode);
                    return false;
                }
            }
        }
    });
}

function isNestedCustomElement(node, owner) {
    return node instanceof Element && node.tagName.includes('-') && node !== owner;
}

function syncAttributes(oldNode, newNode) {
    if (!(newNode instanceof Element)) return;
    for (const attr of newNode.attributes) {
        if (oldNode.getAttribute(attr.name) !== attr.value) {
            oldNode.setAttribute(attr.name, attr.value);
        }
    }
}
