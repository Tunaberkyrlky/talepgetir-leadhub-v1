import { Extension } from '@tiptap/core';
import Suggestion from '@tiptap/suggestion';
import { ReactRenderer } from '@tiptap/react';
import VariableSuggestionList, { type SuggestionItem, type SuggestionListRef } from './VariableSuggestionList';

// {{ ile tetiklenen değişken + spintax otomatik tamamlama.
const ITEMS: SuggestionItem[] = [
    { key: 'first_name', label: 'First Name', insert: '{{first_name}}' },
    { key: 'last_name', label: 'Last Name', insert: '{{last_name}}' },
    { key: 'email', label: 'Email', insert: '{{email}}' },
    { key: 'company_name', label: 'Company', insert: '{{company_name}}' },
    { key: 'title', label: 'Title', insert: '{{title}}' },
    { key: 'website', label: 'Website', insert: '{{website}}' },
    { key: 'industry', label: 'Industry', insert: '{{industry}}' },
    { key: 'random', label: 'Spintax', insert: '{{random|A|B|C}}', spintax: true },
];

export const VariableSuggestion = Extension.create({
    name: 'variableSuggestion',

    addProseMirrorPlugins() {
        return [
            Suggestion<SuggestionItem>({
                editor: this.editor,
                char: '{{',
                startOfLine: false,
                allowSpaces: false,
                items: ({ query }) => {
                    const q = query.toLowerCase();
                    return ITEMS.filter((i) => (`${i.key} ${i.label}`).toLowerCase().includes(q)).slice(0, 8);
                },
                command: ({ editor, range, props }) => {
                    editor.chain().focus().insertContentAt(range, props.insert).run();
                },
                render: () => {
                    let component: ReactRenderer<SuggestionListRef> | null = null;

                    const position = (clientRect?: (() => DOMRect | null) | null) => {
                        if (!component || !clientRect) return;
                        const rect = clientRect();
                        if (!rect) return;
                        const el = component.element as HTMLElement;
                        el.style.position = 'fixed';
                        el.style.left = `${rect.left}px`;
                        el.style.top = `${rect.bottom + 4}px`;
                        el.style.zIndex = '10000';
                    };

                    return {
                        onStart: (props) => {
                            component = new ReactRenderer(VariableSuggestionList, {
                                props, editor: props.editor,
                            });
                            document.body.appendChild(component.element);
                            position(props.clientRect);
                        },
                        onUpdate: (props) => {
                            component?.updateProps(props);
                            position(props.clientRect);
                        },
                        onKeyDown: (props) => {
                            if (props.event.key === 'Escape') {
                                component?.element.remove();
                                return true;
                            }
                            return component?.ref?.onKeyDown(props) ?? false;
                        },
                        onExit: () => {
                            component?.element.remove();
                            component?.destroy();
                            component = null;
                        },
                    };
                },
            }),
        ];
    },
});
