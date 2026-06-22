import { Extension } from '@tiptap/core';
import Suggestion from '@tiptap/suggestion';
import { ReactRenderer } from '@tiptap/react';
import VariableSuggestionList, { type SuggestionListRef } from './VariableSuggestionList';
import { filterVariables, type VariableItem } from './campaignVariables';

// {{ ile tetiklenen değişken + spintax otomatik tamamlama.
export const VariableSuggestion = Extension.create({
    name: 'variableSuggestion',

    addProseMirrorPlugins() {
        return [
            Suggestion<VariableItem>({
                editor: this.editor,
                char: '{{',
                startOfLine: false,
                allowSpaces: false,
                items: ({ query }) => filterVariables(query),
                command: ({ editor, range, props }) => {
                    // Spintax → pill (node); değişken → düz {{key}} metni.
                    const content = props.spintax
                        ? { type: 'spintax', attrs: { options: ['A', 'B', 'C'] } }
                        : props.insert;
                    editor.chain().focus().insertContentAt(range, content).run();
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
