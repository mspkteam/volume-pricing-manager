(function () {
  "use strict";

  function isEmpty(value) {
    if (value == null) return true;
    if (typeof value === "string") return value.trim() === "";
    if (Array.isArray(value)) return value.length === 0;
    if (typeof value === "object") return Object.keys(value).length === 0;
    return false;
  }

  function clauseMatches(clause, answers) {
    var raw = answers[clause.fieldId];
    switch (clause.operator) {
      case "equals":
        return String(raw == null ? "" : raw) === String(clause.value == null ? "" : clause.value);
      case "not_equals":
        return String(raw == null ? "" : raw) !== String(clause.value == null ? "" : clause.value);
      case "contains":
        return String(raw == null ? "" : raw)
          .toLowerCase()
          .indexOf(String(clause.value == null ? "" : clause.value).toLowerCase()) !== -1;
      case "not_empty":
        return !isEmpty(raw);
      case "empty":
        return isEmpty(raw);
      case "in": {
        var list = Array.isArray(clause.value) ? clause.value.map(String) : [String(clause.value)];
        if (Array.isArray(raw)) return raw.map(String).some(function (v) { return list.indexOf(v) !== -1; });
        return list.indexOf(String(raw == null ? "" : raw)) !== -1;
      }
      case "not_in": {
        var list2 = Array.isArray(clause.value) ? clause.value.map(String) : [String(clause.value)];
        if (Array.isArray(raw)) return !raw.map(String).some(function (v) { return list2.indexOf(v) !== -1; });
        return list2.indexOf(String(raw == null ? "" : raw)) === -1;
      }
      case "gt":
      case "gte":
      case "lt":
      case "lte": {
        var a = Number(raw);
        var b = Number(clause.value);
        if (isNaN(a) || isNaN(b)) return false;
        if (clause.operator === "gt") return a > b;
        if (clause.operator === "gte") return a >= b;
        if (clause.operator === "lt") return a < b;
        return a <= b;
      }
      default:
        return false;
    }
  }

  function evaluateGroup(group, answers) {
    if (!group || !group.clauses || !group.clauses.length) return true;
    if (group.logic === "OR") {
      return group.clauses.some(function (c) { return clauseMatches(c, answers); });
    }
    return group.clauses.every(function (c) { return clauseMatches(c, answers); });
  }

  function splitSteps(fields) {
    var steps = [{ title: null, fields: [] }];
    fields.forEach(function (field) {
      if (field.type === "step_break") {
        steps.push({
          title: (field.settings && field.settings.stepTitle) || field.label || "Next step",
          fields: [],
        });
      } else {
        steps[steps.length - 1].fields.push(field);
      }
    });
    if (steps.length > 1 && steps[0].fields.length === 0) steps.shift();
    return steps;
  }

  function el(tag, attrs, children) {
    var node = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        if (k === "className") node.className = attrs[k];
        else if (k === "text") node.textContent = attrs[k];
        else if (k === "html") node.innerHTML = attrs[k];
        else if (attrs[k] != null) node.setAttribute(k, attrs[k]);
      });
    }
    (children || []).forEach(function (c) {
      if (c) node.appendChild(c);
    });
    return node;
  }

  function fieldInput(field, schema) {
    var wrap = el("div", {
      className: "vpm-field",
      "data-field-id": field.id,
      "data-width": field.width || "full",
    });

    if (field.presentational) {
      if (field.type === "heading" || field.type === "section") {
        wrap.appendChild(el("h3", { className: "vpm-step__title", text: field.label }));
        if (field.description) wrap.appendChild(el("p", { text: field.description }));
      } else if (field.type === "paragraph") {
        wrap.appendChild(el("p", { text: field.label }));
      } else if (field.type === "divider") {
        wrap.appendChild(el("hr"));
      }
      return wrap;
    }

    var label = el("label", { className: "vpm-field__label" });
    label.appendChild(document.createTextNode(field.label + " "));
    var reqMark = el("span", { className: "vpm-field__req", text: "*" });
    reqMark.hidden = !field.required;
    label.appendChild(reqMark);
    wrap.appendChild(label);

    var control;
    if (field.type === "long_text") {
      control = el("textarea", {
        name: field.id,
        placeholder: field.placeholder || "",
        rows: "4",
      });
    } else if (field.type === "dropdown" || field.type === "tier_select" || field.type === "country") {
      control = el("select", { name: field.id });
      control.appendChild(el("option", { value: "", text: field.placeholder || "Select…" }));
      var opts =
        field.type === "tier_select"
          ? (field.tierOptions || []).map(function (t) {
              return { value: t.id, label: t.label };
            })
          : field.options || [];
      opts.forEach(function (o) {
        control.appendChild(el("option", { value: o.value || o.id, text: o.label }));
      });
    } else if (field.type === "radio") {
      control = el("div", { className: "vpm-choice" });
      (field.options || []).forEach(function (o) {
        var row = el("label");
        row.appendChild(
          el("input", { type: "radio", name: field.id, value: o.value }),
        );
        row.appendChild(document.createTextNode(o.label));
        control.appendChild(row);
      });
    } else if (field.type === "multi_select" || field.type === "checkbox_group") {
      control = el("div", { className: "vpm-choice", "data-multi": "1" });
      (field.options || []).forEach(function (o) {
        var row = el("label");
        row.appendChild(
          el("input", { type: "checkbox", name: field.id, value: o.value }),
        );
        row.appendChild(document.createTextNode(o.label));
        control.appendChild(row);
      });
    } else if (field.type === "checkbox" || field.type === "consent") {
      control = el("label", { className: "vpm-choice" });
      control.appendChild(el("input", { type: "checkbox", name: field.id, value: "true" }));
      var txt = field.label;
      if (field.type === "consent" && field.settings && field.settings.policyUrl) {
        txt =
          field.label +
          " (" +
          (field.settings.policyLabel || "policy") +
          ")";
      }
      control.appendChild(document.createTextNode(" " + txt));
      wrap.querySelector(".vpm-field__label").hidden = true;
    } else if (field.type === "address") {
      control = el("div", { className: "vpm-address", "data-address": "1" });
      ["line1", "line2", "city", "region", "postal", "country"].forEach(function (key) {
        control.appendChild(
          el("input", {
            type: "text",
            name: field.id + "." + key,
            placeholder: key,
            "data-address-part": key,
          }),
        );
      });
    } else if (field.type === "file_upload") {
      control = el("input", {
        type: "file",
        name: field.id,
        "data-upload": "1",
        multiple: field.settings && Number(field.settings.maxFiles) > 1 ? "multiple" : null,
      });
      if (!(schema.uploadsAvailable || (field.settings && field.settings.uploadsAvailable))) {
        wrap.appendChild(
          el("p", {
            className: "vpm-field__error",
            text: schema.uploadSetupMessage || "Uploads are not configured.",
          }),
        );
        control.disabled = true;
      }
    } else {
      var type = "text";
      if (field.type === "email") type = "email";
      if (field.type === "phone") type = "tel";
      if (field.type === "url") type = "url";
      if (field.type === "number" || field.type === "currency") type = "number";
      if (field.type === "date") type = "date";
      control = el("input", {
        type: type,
        name: field.id,
        placeholder: field.placeholder || "",
      });
    }

    wrap.appendChild(control);
    if (field.helperText) {
      wrap.appendChild(el("p", { className: "vpm-field__helper", text: field.helperText }));
    }
    wrap.appendChild(el("p", { className: "vpm-field__error", "data-error": "1", hidden: "hidden" }));
    return wrap;
  }

  function collectAnswers(root) {
    var answers = {};
    root.querySelectorAll(".vpm-field[data-field-id]").forEach(function (wrap) {
      if (wrap.classList.contains("is-hidden") || wrap.hidden) return;
      var id = wrap.getAttribute("data-field-id");
      var address = wrap.querySelector("[data-address]");
      var multi = wrap.querySelector("[data-multi]");
      if (address) {
        var obj = {};
        address.querySelectorAll("[data-address-part]").forEach(function (inp) {
          obj[inp.getAttribute("data-address-part")] = inp.value;
        });
        answers[id] = obj;
        return;
      }
      if (multi) {
        answers[id] = Array.prototype.slice
          .call(multi.querySelectorAll('input[type="checkbox"]:checked'))
          .map(function (i) { return i.value; });
        return;
      }
      var radios = wrap.querySelectorAll('input[type="radio"]');
      if (radios.length) {
        var checked = wrap.querySelector('input[type="radio"]:checked');
        answers[id] = checked ? checked.value : "";
        return;
      }
      var file = wrap.querySelector('input[type="file"][data-upload]');
      if (file) {
        answers[id] = file.getAttribute("data-upload-ids")
          ? JSON.parse(file.getAttribute("data-upload-ids"))
          : [];
        return;
      }
      var cb = wrap.querySelector('input[type="checkbox"]');
      if (cb && !multi) {
        answers[id] = cb.checked;
        return;
      }
      var input = wrap.querySelector("input, select, textarea");
      if (input) answers[id] = input.value;
    });
    return answers;
  }

  function setFieldError(wrap, message) {
    var err = wrap.querySelector("[data-error]");
    if (!err) return;
    if (message) {
      err.textContent = message;
      err.hidden = false;
    } else {
      err.textContent = "";
      err.hidden = true;
    }
  }

  function validateStep(stepRoot, fields, answers) {
    var ok = true;
    fields.forEach(function (field) {
      if (field.presentational) return;
      var wrap = stepRoot.querySelector('.vpm-field[data-field-id="' + field.id + '"]');
      if (!wrap || wrap.classList.contains("is-hidden")) return;
      setFieldError(wrap, "");
      var visible = evaluateGroup(field.visibility, answers);
      if (!visible) return;
      var required = field.required || evaluateGroup(field.requiredWhen, answers);
      var value = answers[field.id];
      if (required) {
        if (field.type === "checkbox" || field.type === "consent") {
          if (!(value === true || value === "true")) {
            setFieldError(wrap, field.label + " is required");
            ok = false;
          }
        } else if (isEmpty(value)) {
          setFieldError(wrap, field.label + " is required");
          ok = false;
        }
      }
      if (field.type === "email" && value && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/i.test(String(value))) {
        setFieldError(wrap, "Enter a valid email");
        ok = false;
      }
    });
    return ok;
  }

  function applyVisibility(root, fields, answers) {
    fields.forEach(function (field) {
      var wrap = root.querySelector('.vpm-field[data-field-id="' + field.id + '"]');
      if (!wrap) return;
      var visible = evaluateGroup(field.visibility, answers);
      wrap.classList.toggle("is-hidden", !visible);
      var req = wrap.querySelector(".vpm-field__req");
      if (req) {
        var required = field.required || evaluateGroup(field.requiredWhen, answers);
        req.hidden = !required;
      }
    });
  }

  function uuid() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    return "idemp_" + String(Date.now()) + "_" + Math.random().toString(16).slice(2);
  }

  async function uploadFiles(proxyBase, field, fileInput) {
    var files = Array.prototype.slice.call(fileInput.files || []);
    var ids = [];
    for (var i = 0; i < files.length; i++) {
      var fd = new FormData();
      fd.set("fieldId", field.id);
      fd.set("file", files[i]);
      var res = await fetch(proxyBase + "/upload" + window.location.search, {
        method: "POST",
        body: fd,
        credentials: "same-origin",
      });
      var data = await res.json().catch(function () { return {}; });
      if (!res.ok) throw new Error(data.error || "Upload failed");
      ids.push(data.uploadId);
    }
    fileInput.setAttribute("data-upload-ids", JSON.stringify(ids));
    return ids;
  }

  function mount(root) {
    var handle = root.getAttribute("data-form-handle");
    var proxyBase = root.getAttribute("data-proxy-base");
    if (!handle) return;

    var loading = root.querySelector("[data-vpm-loading]");
    var errorBox = root.querySelector("[data-vpm-error]");
    var successBox = root.querySelector("[data-vpm-success]");
    var body = root.querySelector("[data-vpm-body]");
    var stepsEl = root.querySelector("[data-vpm-steps]");
    var prevBtn = root.querySelector("[data-vpm-prev]");
    var nextBtn = root.querySelector("[data-vpm-next]");
    var submitBtn = root.querySelector("[data-vpm-submit]");
    var showHeading = root.getAttribute("data-show-heading") === "true";
    var showDescription = root.getAttribute("data-show-description") === "true";

    var state = {
      schema: null,
      steps: [],
      stepIndex: 0,
      submitting: false,
      idempotencyKey: uuid(),
    };

    function showError(msg) {
      errorBox.hidden = !msg;
      errorBox.textContent = msg || "";
    }

    function render() {
      var schema = state.schema;
      stepsEl.innerHTML = "";
      if (showHeading) {
        stepsEl.appendChild(el("h2", { className: "vpm-form__title", text: schema.title }));
      }
      if (showDescription && schema.description) {
        stepsEl.appendChild(el("p", { className: "vpm-form__desc", text: schema.description }));
      }
      if (schema.requireLogin && !schema.loggedInCustomerId) {
        stepsEl.appendChild(
          el("div", {
            className: "vpm-form__login",
            html: "Please <a href=\"/account/login\">log in</a> to submit this form.",
          }),
        );
        submitBtn.disabled = true;
      }

      state.steps = splitSteps(schema.fields || []);
      state.steps.forEach(function (step, idx) {
        var panel = el("div", {
          className: "vpm-step" + (idx === 0 ? " is-active" : ""),
          "data-step": String(idx),
        });
        if (state.steps.length > 1) {
          panel.appendChild(
            el("p", {
              className: "vpm-progress",
              text: "Step " + (idx + 1) + " of " + state.steps.length,
            }),
          );
          if (step.title) panel.appendChild(el("h3", { className: "vpm-step__title", text: step.title }));
        }
        step.fields.forEach(function (field) {
          panel.appendChild(fieldInput(field, schema));
        });
        stepsEl.appendChild(panel);
      });

      updateNav();
      refreshVisibility();
      loading.hidden = true;
      body.hidden = false;
    }

    function updateNav() {
      var multi = state.steps.length > 1;
      prevBtn.hidden = !multi || state.stepIndex === 0;
      nextBtn.hidden = !multi || state.stepIndex >= state.steps.length - 1;
      submitBtn.hidden = multi && state.stepIndex < state.steps.length - 1;
    }

    function refreshVisibility() {
      var answers = collectAnswers(root);
      applyVisibility(root, state.schema.fields || [], answers);
    }

    function goStep(delta) {
      var panels = root.querySelectorAll(".vpm-step");
      var current = panels[state.stepIndex];
      var answers = collectAnswers(root);
      if (delta > 0) {
        var fields = state.steps[state.stepIndex].fields;
        if (!validateStep(current, fields, answers)) return;
      }
      panels[state.stepIndex].classList.remove("is-active");
      state.stepIndex += delta;
      panels[state.stepIndex].classList.add("is-active");
      updateNav();
      refreshVisibility();
    }

    root.addEventListener("change", refreshVisibility);
    root.addEventListener("input", refreshVisibility);
    prevBtn.addEventListener("click", function () { goStep(-1); });
    nextBtn.addEventListener("click", function () { goStep(1); });

    body.addEventListener("submit", async function (e) {
      e.preventDefault();
      if (state.submitting) return;
      showError("");
      var answers = collectAnswers(root);
      var last = root.querySelector('.vpm-step[data-step="' + state.stepIndex + '"]');
      if (!validateStep(last, state.steps[state.stepIndex].fields, answers)) return;

      state.submitting = true;
      submitBtn.disabled = true;
      submitBtn.textContent = "Submitting…";

      try {
        var uploadFields = (state.schema.fields || []).filter(function (f) {
          return f.type === "file_upload";
        });
        for (var i = 0; i < uploadFields.length; i++) {
          var f = uploadFields[i];
          var wrap = root.querySelector('.vpm-field[data-field-id="' + f.id + '"]');
          if (!wrap || wrap.classList.contains("is-hidden")) continue;
          var input = wrap.querySelector('input[type="file"]');
          if (input && input.files && input.files.length) {
            answers[f.id] = await uploadFiles(proxyBase, f, input);
          }
        }

        var res = await fetch(proxyBase + "/submit" + window.location.search, {
          method: "POST",
          credentials: "same-origin",
          headers: { "Content-Type": "application/json", Accept: "application/json" },
          body: JSON.stringify({
            answers: answers,
            cacheKey: state.schema.cacheKey,
            idempotencyKey: state.idempotencyKey,
          }),
        });
        var data = await res.json().catch(function () { return {}; });
        if (!res.ok) {
          var msg = data.error || "Submission failed";
          if (data.errors && data.errors.length) {
            msg = data.errors.map(function (err) { return err.message; }).join("; ");
          }
          throw new Error(msg);
        }
        body.hidden = true;
        successBox.hidden = false;
        successBox.textContent =
          state.schema.successMessage || "Thank you — we received your application.";
      } catch (err) {
        showError(err.message || "Submission failed");
        submitBtn.disabled = false;
        submitBtn.textContent = state.schema.submitLabel || "Submit";
        state.submitting = false;
      }
    });

    fetch(proxyBase + window.location.search, {
      credentials: "same-origin",
      headers: { Accept: "application/json" },
    })
      .then(function (res) {
        return res.json().then(function (data) {
          if (!res.ok) throw new Error(data.error || "Could not load form");
          return data;
        });
      })
      .then(function (schema) {
        state.schema = schema;
        if (submitBtn) submitBtn.textContent = schema.submitLabel || "Submit";
        render();
      })
      .catch(function (err) {
        loading.hidden = true;
        showError(err.message || "Could not load form");
      });
  }

  function init() {
    document.querySelectorAll("[data-vpm-form]").forEach(mount);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
