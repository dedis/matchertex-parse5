import { it, assert } from 'vitest';
import * as fs from 'node:fs';
import { type TreeAdapterTypeMap, type SerializerOptions, parse } from 'parse5';
import { generateTestsForEachTreeAdapter, getStringDiffMsg } from './common.js';

export function generateSerializerTests(
    name: string,
    prefix: string,
    serialize: (
        document: TreeAdapterTypeMap['document'],
        opts: SerializerOptions<TreeAdapterTypeMap>,
    ) => Promise<string> | string,
    { expectErrors = [] }: { expectErrors?: number[] } = {},
): void {
    const data = fs.readFileSync(new URL('../data/serialization/tests.json', import.meta.url)).toString('utf8');
    const tests = JSON.parse(data) as {
        name: string;
        options?: SerializerOptions<TreeAdapterTypeMap>;
        input: string;
        expected: string;
    }[];

    for (const idx of expectErrors) {
        if (!tests[idx]) {
            throw new Error(`Expected error test ${idx} was not found`);
        }
    }

    generateTestsForEachTreeAdapter(name, (treeAdapter) => {
        for (const [idx, test] of tests.entries()) {
            it(`${prefix} - ${idx}.${test.name}`, async () => {
                const opts = { ...test.options, treeAdapter };
                const document = parse(test.input, opts);
                const expectError = expectErrors.includes(idx);
                let serializedResult: string;

                try {
                    serializedResult = await serialize(document, opts);
                } catch (error) {
                    if (expectError) {
                        return;
                    }

                    throw error;
                }

                if (expectError) {
                    assert.ok(serializedResult !== test.expected, 'Expected an error or a different output');
                    return;
                }

                //NOTE: use ok assertion, so output will not be polluted by the whole content of the strings
                assert.ok(serializedResult === test.expected, getStringDiffMsg(serializedResult, test.expected));
            });
        }
    });
}
