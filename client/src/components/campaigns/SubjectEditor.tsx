import { forwardRef, useImperativeHandle, useState } from 'react';
import type { ReactNode } from 'react';
import { Input } from '@mantine/core';
import { useEditor, EditorContent } from '@tiptap/react';
import type { Editor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { VariableSuggestion } from './variableSuggestion';
import { Spintax } from './spintaxNode';
import { subjectToDoc } from './spintaxSerialize';

export interface SubjectEditorRef {
    insertVariable: (text: string) => void;
    insertSpintax: () => void;
    focus: () => void;
}

interface Props {
    value: string;
    onChange: (v: string) => void;
    onFocus?: () => void;
    disabled?: boolean;
    required?: boolean;
    label?: ReactNode;
    placeholder?: string;
}

// Spintax node'unu {{random|...}} metnine çeviren text serializer (konu düz metin).
function serialize(editor: Editor): string {
    return editor
        .getText({
            blockSeparator: ' ',
            textSerializers: {
                spintax: ({ node }) => `{{random|${((node.attrs.options as string[]) || []).join('|')}}}`,
            },
        })
        .replace(/\s*\n\s*/g, ' ');
}

// Konu satırı — gövdedeki gibi spintax pill + {{ autocomplete, ama tek satır ve düz
// metin olarak kaydedilir. Tek satır: Enter yutulur, biçimlendirme kapalı.
const SubjectEditor = forwardRef<SubjectEditorRef, Props>(
    ({ value, onChange, onFocus, disabled, required, label, placeholder }, ref) => {
        const [focused, setFocused] = useState(false);

        const editor = useEditor({
            extensions: [
                StarterKit.configure({
                    heading: false, blockquote: false, bulletList: false, orderedList: false,
                    listItem: false, codeBlock: false, horizontalRule: false, hardBreak: false,
                    bold: false, italic: false, strike: false, code: false,
                }),
                VariableSuggestion,
                Spintax,
            ],
            content: subjectToDoc(value),
            editable: !disabled,
            editorProps: {
                attributes: { class: 'subject-editor-pm' },
                // Tek satır: Enter yeni satır açmasın (öneri açıkken eklenti zaten önce işler).
                handleKeyDown: (_view, event) => event.key === 'Enter',
            },
            onUpdate: ({ editor }) => onChange(serialize(editor)),
            onFocus: () => { setFocused(true); onFocus?.(); },
            onBlur: () => setFocused(false),
        });

        useImperativeHandle(ref, () => ({
            insertVariable: (text: string) => { editor?.chain().focus().insertContent(text).run(); },
            insertSpintax: () => { editor?.chain().focus().insertContent({ type: 'spintax', attrs: { options: ['A', 'B', 'C'] } }).run(); },
            focus: () => { editor?.chain().focus().run(); },
        }), [editor]);

        return (
            <Input.Wrapper label={label} required={required} size="sm">
                <div
                    onClick={() => editor?.chain().focus().run()}
                    style={{
                        position: 'relative',
                        border: `1px solid ${focused ? 'var(--mantine-color-violet-5)' : 'var(--mantine-color-gray-4)'}`,
                        borderRadius: 8,
                        padding: '6px 12px',
                        minHeight: 36,
                        fontSize: 14,
                        lineHeight: 1.55,
                        cursor: disabled ? 'not-allowed' : 'text',
                        background: disabled ? 'var(--mantine-color-gray-1)' : 'var(--mantine-color-body)',
                    }}
                >
                    {editor?.isEmpty && placeholder && (
                        <span style={{ position: 'absolute', top: 6, left: 12, color: 'var(--mantine-color-placeholder)', pointerEvents: 'none' }}>
                            {placeholder}
                        </span>
                    )}
                    <EditorContent editor={editor} />
                </div>
            </Input.Wrapper>
        );
    },
);

SubjectEditor.displayName = 'SubjectEditor';
export default SubjectEditor;
