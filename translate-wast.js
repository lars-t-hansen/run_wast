// A shell script around this code must do two things:
//
//  - Set a global variable called INPUT_FILE with the name of the input file
//  - Capture the output

function main() {
    if (!this.INPUT_FILE) {
        print("Error: No input file");
        exit(1);
    }

    let input = os.file.readFile(INPUT_FILE);

    let tokens = new TokStream(tokenize(input));
    while (!tokens.atEnd()) {
        if (tokens.peek(['(', 'module'])) {
            // This turns into an instance definition
            print("var ins = new WebAssembly.Instance(new WebAssembly.Module(wasmTextToBinary(`" + tokens.collect().join(' ') + "`)));");
        } else if (tokens.peek(['(', 'assert_return', '(', 'invoke'])) {
            let ts = new TokStream(tokens.collect());
            ts.match(['(', 'assert_return']);
            let invoke_toks = new TokStream(ts.collect());
            let result_toks = new TokStream(ts.collect());
            ts.match([')']);
            assertEq(ts.atEnd(), true);

            invoke_toks.match(['(', 'invoke']);
            let fn_name = invoke_toks.get();
            let fn_params = [];
            while (!invoke_toks.peek([')']))
                fn_params.push(invoke_toks.collect());
            invoke_toks.match([')']);
            let fn_param_types = fn_params.map((x) => get_type_from_const(x[1]));

            let fn_results = [];
            while (!result_toks.atEnd())
                fn_results.push(result_toks.collect());
            let fn_result_types = fn_results.map((x) => get_type_from_const(x[1]));

            // TODO: Only one result for now
            assertEq(fn_result_types.length <= 1, true);
            let fn_compare_type = fn_result_types[0] == 'v128' ? 'i8x16' : fn_result_types[0];

            print("var run = new WebAssembly.Instance(new WebAssembly.Module(wasmTextToBinary(`");
            print(`
(module
  (import "" ${fn_name} (func $f (param ${fn_param_types.join(' ')}) (result ${fn_result_types.join(' ')})))
  (func (export "run") (result i32)
    (${fn_compare_type}.all_true (${fn_compare_type}.eq (call $f ${fn_params.map((x) => x.join(' '))}) ${fn_results[0].join(' ')}))))
`);
            print("`)), {'':ins.exports});");
            print("assertEq(run.exports.run(), 1)");
        } else {
            break;
        }
        /*
          } else if (p.indexOf('(assert_trap (invoke') == 0) {
          // Basically the same but we need to setup an exception handler and expect
          // the exception, we'll ignore the error message
          } else if (p.indexOf('(assert_malformed') == 0) {
          // Syntax failure
          } else if (p.indexOf('(assert_invalid') == 0) {
          // Validation failure
          }
        */

    }
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

function tokenize(s) {
    let i = 0;
    let len = s.length;
    let tokens = [];
    while (i < len) {
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
        default: {
            let x = s[i++];
            loop:
            while (i < len) {
                switch (s[i]) {
                case ' ': case '\t': case '\n': case '\r':
                case ';':
                case '(':
                case ')':
                case '"':
                    break loop;
                default:
                    x += s[i++];
                    break;
                }
            }
            tokens.push(x);
            continue;
        }
        }
    }
    return tokens;
}

function get_type_from_const(s) {
    return s.match(/([ifv]\d+)\.const/)[1];
}

function TokStream(tokens) {
    this.tokens = tokens;
    this.i = 0;
    this.lim = tokens.length;
}

TokStream.prototype.atEnd = function () {
    return this.i >= this.lim;
}

TokStream.prototype.get = function () {
    assertEq(this.i < this.lim, true);
    return this.tokens[this.i++];
}

TokStream.prototype.peek = function (ts) {
    for ( let i=0 ; i < ts.length ; i++ ) {
        if (ts[i] != this.tokens[this.i+i])
            return false;
    }
    return true;
}

TokStream.prototype.match = function (ts) {
    if (!this.peek(ts))
        throw "Did not match: " + ts.join(' ');
    this.skip(ts.length);
}

TokStream.prototype.skip = function (n) {
    this.i += n;
}

TokStream.prototype.collect = function () {
    assertEq(this.tokens[this.i], '(');
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

main();
