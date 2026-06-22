import { Node, mergeAttributes } from '@tiptap/core';
import { ReactNodeViewRenderer } from '@tiptap/react';
import SpintaxNodeView from './SpintaxNodeView';

// Inline atom node — {{random|A|B|C}} bloğunu pill olarak gösterir.
// HTML serileştirmesi <span data-spintax="A|B|C"> şeklindedir; kaydetmeden önce
// spintaxHtmlToText ile kanonik {{random|...}} metnine çevrilir (bkz. spintaxSerialize).
export const Spintax = Node.create({
    name: 'spintax',
    group: 'inline',
    inline: true,
    atom: true,
    selectable: true,
    draggable: false,

    addAttributes() {
        return {
            options: {
                default: [] as string[],
                parseHTML: (el) => (el.getAttribute('data-spintax') || '').split('|'),
                renderHTML: (attrs) => ({ 'data-spintax': ((attrs.options as string[]) || []).join('|') }),
            },
        };
    },

    parseHTML() {
        return [{ tag: 'span[data-spintax]' }];
    },

    renderHTML({ HTMLAttributes }) {
        return ['span', mergeAttributes(HTMLAttributes)];
    },

    addNodeView() {
        return ReactNodeViewRenderer(SpintaxNodeView);
    },
});
