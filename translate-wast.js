// Translate .wast files to JS for the SpiderMonkey shell.
//
// This script is itself for the SpiderMonkey shell.
//
// A regular shell script around this code must do two things:
//
//  - Set a global variable called INPUT_FILE with the name of the input file
//  - Capture the output in an output file, this script writes to stdout

function main() {
    if (!this.INPUT_FILE) {
        print("Error: No input file");
        exit(1);
    }

    let input = os.file.readFile(INPUT_FILE);

    let tokens = new Tokens(tokenize(input));
    let last_module = null;
    while (!tokens.atEnd()) {
        if (tokens.peek(['(', 'module'])) {
            // This turns into an instance definition
            last_module = tokens.collect();
            print("var ins = new WebAssembly.Instance(new WebAssembly.Module(wasmTextToBinary(`" +
                  last_module.join(' ') +
                  "`)));");
        } else if (tokens.peek(['(', 'assert_return', '(', 'invoke'])) {
            // (assert_return (invoke fn arg ...) result ...)
            // where each arg and each result is a const
            // and the fn is bound by the preceding module
            let ts = new Tokens(tokens.collect());
            ts.match(['(', 'assert_return']);
            let invoke_toks = new Tokens(ts.collect());
            let result_toks = new Tokens(ts.collect());
            ts.match([')']);
            assertEq(ts.atEnd(), true);

            let [fn_name, fn_params, fn_param_types] = parseInvoke(invoke_toks);

            let fn_results = [];
            while (!result_toks.atEnd())
                fn_results.push(result_toks.collect());
            let fn_result_types = fn_results.map(resultType);

            let mod = "";
            if (fn_result_types.length == 0) {
                mod = `
(module
  (import "" ${fn_name} (func $f (param ${fn_param_types.join(' ')})))
  (func (export "run") (result i32)
    (call $f ${fn_params.flat().map(sanitizeVal).join(' ')})
    (i32.const 1)))
`;
            } else if (fn_result_types.length == 1) {
                // Comparisons and reductions are a little hacky.  We prefer the
                // type-specific comparisons when we can, but we have no
                // i64x2.eq, so we use i32x4.eq in this case; it is correct to
                // do so.
                //
                // When the comparisons are not scalar we must reduce the result
                // to a scalar.  Reductions are similar to compares: there are
                // restrictions.  We have no i64x2.all_true, for example, and
                // none for the floats anyway.  But we can always use i8x16 to
                // reduce because we know a lane is either 0 or -1, and if we
                // really mean all_true then we really mean all_bits_set here.
                //
                // The following is not right for NaN.  In that case we must
                // either do !(x == x) for the possibly-NaN fields, or we must
                // drop down to integer compares if we're sure we got the bit
                // patterns right.
                let fn_compare_type = compareType(fn_results[0]);
                let must_reduce = fn_compare_type.match('x');
                if (fn_compare_type == 'i64x2')
                    fn_compare_type = 'i32x4';
                let invoke = `(${fn_compare_type}.eq (call $f ${fn_params.flat().map(sanitizeVal).join(' ')}) ${fn_results[0].map(sanitizeVal).join(' ')})`;
                let body = must_reduce ? `(i8x16.all_true ${invoke})` : invoke;
                mod = `
(module
  (import "" ${fn_name} (func $f (param ${fn_param_types.join(' ')}) (result ${fn_result_types.join(' ')})))
  (func (export "run") (result i32) ${body}))
`;
            } else {
                // TODO: Multi-result
                throw "Multi-result not implemented"
            }

            print("var run = new WebAssembly.Instance(new WebAssembly.Module(wasmTextToBinary(`");
            print(mod);
            print("`)), {'':ins.exports});");
            print("assertEq(run.exports.run(), 1)");
        } else if (tokens.peek(['(', 'assert_trap', '(', 'invoke'])) {
            // (assert_trap (invoke fn arg ...) errormsg)
            // where each arg is a const
            // and the fn is bound by the preceding module
            let ts = new Tokens(tokens.collect());
            ts.match(['(', 'assert_trap']);
            let invoke_toks = new Tokens(ts.collect());
            let error_msg = ts.matchString();
            ts.match([')']);
            assertEq(ts.atEnd(), true);

            let [fn_name, fn_params, fn_param_types] = parseInvoke(invoke_toks);

            // TODO: the "drop" is wrong because we don't know that it's
            // correct.  To do better we have to find and parse the callee.  Not
            // the end of the world, but annoying.
            if (false) {
                print("var run = new WebAssembly.Instance(new WebAssembly.Module(wasmTextToBinary(`");
                print(`
(module
  (import "" ${fn_name} (func $f (param ${fn_param_types.join(' ')})))
  (func (export "run")
    (drop (call $f ${fn_params.flat().join(' ')}))))
`);
                print("`)), {'':ins.exports});");
                print("var thrown = false;");
                print("try { run.exports.run() } catch (e) { thrown = true; }");
                print("if (!thrown) throw 'Error: expected exception';");
            }
        } else if (tokens.peek(['(', 'assert_malformed'])) {
            // Syntax failure - not hard
            tokens.collect();
        } else if (tokens.peek(['(', 'assert_invalid'])) {
            // Validation failure - not hard
            tokens.collect();
        } else {
            throw "Unexpected phrase: " + tokens.peekPrefix(10);
        }
    }
}

// Not obvious that this is what we want but these values appearing in the test
// suite are not standard, from what I can tell.
function sanitizeVal(v) {
    if (v == "nan:canonical") return "nan";
    if (v == "nan:arithmetic") return "nan";
    return v;
}

function parseInvoke(invoke_toks) {
    invoke_toks.match(['(', 'invoke']);
    let fn_name = invoke_toks.matchString();
    let fn_params = [];
    while (!invoke_toks.peek([')']))
        fn_params.push(invoke_toks.collect());
    invoke_toks.match([')']);
    assertEq(invoke_toks.atEnd(), true);
    let fn_param_types = fn_params.map(paramType);

    return [fn_name, fn_params, fn_param_types];
}

function tokenize(s) {
    let i = 0;
    let len = s.length;
    let tokens = [];
    while (i < len) {
        if (!issep(s[i])) {
            let x = s[i++];
            while (i < len && !issep(s[i]))
                x += s[i++];
            tokens.push(x);
        } else {
            switch (s[i]) {
            case ' ': case '\t': case '\r': case '\n':
                i++;
                continue;
            case ';':
                i++;
                while (i < len && !(s[i] == '\r' || s[i] == '\n'))
                    i++;
                continue;
            case '(':
            case ')':
                tokens.push(s[i++]);
                continue;
            case '"': {
                let x = s[i++];
                while (i < len && s[i] != '"') {
                    let c = s[i++];
                    x += c;
                    if (c == '\\') {
                        x += '\\';
                    }
                }
                if (i < len)
                    x += s[i++];
                tokens.push(x);
                continue;
            }
            default:
                print("Error: internal inconsistency");
                exit(1);
            }
        }
    }
    return tokens;
}

function isxdigit(c) {
    switch (c) {
    case '0': case '1': case '2': case '3':
    case '4': case '5': case '6': case '7':
    case '8': case '9': case 'a': case 'b':
    case 'c': case 'd': case 'e': case 'f':
    case 'A': case 'B': case 'C': case 'D':
    case 'E': case 'F':
        return true;
    default:
        return false;
    }
}

function issep(c) {
    switch (c) {
    case ' ': case '\t': case '\n': case '\r':
    case ';':
    case '(':
    case ')':
    case '"':
        return true;
    default:
        return false;
    }
}

// The input here is ( token ... ) since for v128 consts the type is actually
// the second token.

function compareType(ct) {
    let ts = new Tokens(ct);
    ts.match(['(']);
    let c = ts.get();
    switch (c) {
    case 'i32.const': return 'i32';
    case 'i64.const': return 'i64';
    case 'f32.const': return 'f32';
    case 'f64.const': return 'f64';
    case 'v128.const': return ts.get();
    default: throw "Unexpected const token " + c;
    }
}

function paramType(ct) {
    let ts = new Tokens(ct);
    ts.match(['(']);
    let c = ts.get();
    switch (c) {
    case 'i32.const': return 'i32';
    case 'i64.const': return 'i64';
    case 'f32.const': return 'f32';
    case 'f64.const': return 'f64';
    case 'v128.const': return 'v128';
    default: throw "Unexpected const token " + c;
    }
}

function resultType(ct) {
    return paramType(ct);
}

class Tokens {
    constructor (tokens) {
        this.tokens = tokens;
        this.i = 0;
        this.lim = tokens.length;
    }
    atEnd() {
        return this.i >= this.lim;
    }
    get() {
        this.assertAvail(1);
        return this.tokens[this.i++];
    }
    peek(ts) {
        for ( let i=0 ; i < ts.length ; i++ ) {
            if (ts[i] != this.tokens[this.i+i])
                return false;
        }
        return true;
    }
    peekPrefix(n) {
        let ts = [];
        let i = this.i;
        while (n > 0 && i < this.lim) {
            ts.push(this.tokens[i++]);
            n--;
        }
        return ts;
    }
    match(ts) {
        if (!this.peek(ts))
            throw "Did not match: " + ts.join(' ');
        this.skip(ts.length);
    }
    matchString() {
        this.assertAvail(1);
        let t = this.tokens[this.i];
        this.assertEq('"', t[0]);
        this.i++;
        return t;
    }
    skip(n) {
        this.i += n;
    }
    collect() {
        if (this.peek([')']))
            return [];
        this.assertEq('(', this.tokens[this.i]);
        let ts = ['('];
        let d = 1;
        this.i++;
        while (this.i < this.lim && d > 0) {
            ts.push(this.tokens[this.i]);
            if (this.tokens[this.i] == '(')
                d++;
            else if (this.tokens[this.i] == ')')
                d--;
            this.i++;
        }
        return ts;
    }
    assertEq(expected, got) {
        if (got != expected)
            throw "Expected to see " + expected + " but got " + got;
    }
    assertAvail(n) {
        if (this.i + n > this.lim)
            throw "Not enough tokens: " + n;
    }
}

main();
