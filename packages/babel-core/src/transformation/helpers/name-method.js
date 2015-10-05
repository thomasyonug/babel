/* @flow */

import type { Scope } from "babel-traverse";
import type File from "../file";
import getFunctionArity from "./get-function-arity";
import * as util from  "../../util";
import * as t from "babel-types";

let visitor = {
  "ReferencedIdentifier|BindingIdentifier"(path, state) {
    // check if this node matches our function id
    if (path.node.name !== state.name) return;

    // check that we don't have a local variable declared as that removes the need
    // for the wrapper
    let localDeclar = path.scope.getBindingIdentifier(state.name);
    if (localDeclar !== state.outerDeclar) return;

    state.selfReference = true;
    path.stop();
  }
};

function wrap(state, method, id, scope) {
  if (state.selfReference) {
    if (scope.hasBinding(id.name) && !scope.hasGlobal(id.name)) {
      // we can just munge the local binding
      scope.rename(id.name);
    } else {
      // need to add a wrapper since we can't change the references
      let templateName = "property-method-assignment-wrapper";
      if (method.generator) templateName += "-generator";
      let template = util.template(templateName, {
        FUNCTION: method,
        FUNCTION_ID: id,
        FUNCTION_KEY: scope.generateUidIdentifier(id.name)
      });
      template.callee._skipModulesRemap = true;

      // shim in dummy params to retain function arity, if you try to read the
      // source then you'll get the original since it's proxied so it's all good
      let params = template.callee.body.body[0].params;
      for (let i = 0, len = getFunctionArity(method); i < len; i++) {
        params.push(scope.generateUidIdentifier("x"));
      }

      return template;
    }
  }

  method.id = id;
  scope.getProgramParent().references[id.name] = true;
}

function visit(node, name, scope) {
  let state = {
    selfAssignment: false,
    selfReference:  false,
    outerDeclar:    scope.getBindingIdentifier(name),
    references:     [],
    name:           name
  };

  // check to see if we have a local binding of the id we're setting inside of
  // the function, this is important as there are caveats associated

  let binding = scope.getOwnBinding(name);

  if (binding) {
    if (binding.kind === "param") {
      // safari will blow up in strict mode with code like:
      //
      //   let t = function t(t) {};
      //
      // with the error:
      //
      //   Cannot declare a parameter named 't' as it shadows the name of a
      //   strict mode function.
      //
      // this isn't to the spec and they've invented this behaviour which is
      // **extremely** annoying so we avoid setting the name if it has a param
      // with the same id
      state.selfReference = true;
    } else {
      // otherwise it's defined somewhere in scope like:
      //
      //   let t = function () {
      //     let t = 2;
      //   };
      //
      // so we can safely just set the id and move along as it shadows the
      // bound function id
    }
  } else if (state.outerDeclar || scope.hasGlobal(name)) {
    scope.traverse(node, visitor, state);
  }

  return state;
}

export function custom(node: Object, id: Object, scope: Scope) {
  let state = visit(node, id.name, scope);
  return wrap(state, node, id, scope);
}

export function property(node: Object, file: File, scope: Scope) {
  let key = t.toComputedKey(node, node.key);
  if (!t.isLiteral(key)) return; // we can't set a function id with this

  let name = t.toBindingIdentifierName(key.value);
  let id = t.identifier(name);

  let method = node.value;
  let state  = visit(method, name, scope);
  node.value = wrap(state, method, id, scope) || method;
}

export function bare(node: Object, parent: Object, scope: Scope) {
  // has an `id` so we don't need to infer one
  if (node.id) return;

  let id;
  if (t.isProperty(parent) && parent.kind === "init" && (!parent.computed || t.isLiteral(parent.key))) {
    // { foo() {} };
    id = parent.key;
  } else if (t.isVariableDeclarator(parent)) {
    // let foo = function () {};
    id = parent.id;

    if (t.isIdentifier(id)) {
      let binding = scope.parent.getBinding(id.name);
      if (binding && binding.constant && scope.getBinding(id.name) === binding) {
        // always going to reference this method
        node.id = id;
        return;
      }
    }
  } else {
    return;
  }

  let name;
  if (id && t.isLiteral(id)) {
    name = id.value;
  } else if (id && t.isIdentifier(id)) {
    name = id.name;
  } else {
    return;
  }

  name = t.toBindingIdentifierName(name);
  id = t.identifier(name);

  let state = visit(node, name, scope);
  return wrap(state, node, id, scope);
}