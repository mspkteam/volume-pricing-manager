(function () {
  if (window.VPMWarranty) return;

  function el(tag, attrs, children) {
    var node = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        if (attrs[k] == null) return;
        if (k === "className") node.className = attrs[k];
        else if (k === "text") node.textContent = attrs[k];
        else node.setAttribute(k, attrs[k]);
      });
    }
    (children || []).forEach(function (c) {
      if (c) node.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
    });
    return node;
  }

  function field(label, input) {
    return el("div", { className: "vpm-warranty__field" }, [
      el("label", { className: "vpm-warranty__label", text: label }),
      input,
    ]);
  }

  function uuid() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    return "wty-" + Date.now() + "-" + Math.random().toString(16).slice(2);
  }

  function money(minor, currency) {
    try {
      return new Intl.NumberFormat(undefined, {
        style: "currency",
        currency: currency || "USD",
      }).format((Number(minor) || 0) / 100);
    } catch (_) {
      return "$" + ((Number(minor) || 0) / 100).toFixed(2);
    }
  }

  function mount(root) {
    if (root.getAttribute("data-vpm-warranty-ready") === "1") return;
    root.setAttribute("data-vpm-warranty-ready", "1");

    var loading = root.querySelector("[data-vpm-loading]");
    var errorEl = root.querySelector("[data-vpm-error]");
    var successEl = root.querySelector("[data-vpm-success]");
    var body = root.querySelector("[data-vpm-body]");
    var proxyBase = root.getAttribute("data-proxy-base") || "/apps/volume-pricing/warranty";

    function showError(msg) {
      if (loading) loading.hidden = true;
      if (errorEl) {
        errorEl.hidden = false;
        errorEl.textContent = msg;
      }
    }

    fetch(proxyBase + "/settings", { credentials: "same-origin", headers: { Accept: "application/json" } })
      .then(function (r) {
        if (!r.ok) throw new Error("Could not load warranty settings");
        return r.json();
      })
      .then(function (data) {
        var settings = data.settings || {};
        if (loading) loading.hidden = true;
        if (body) body.hidden = false;

        var intro = root.querySelector("[data-vpm-intro]");
        if (intro && settings.introHtml) intro.innerHTML = settings.introHtml;

        var note = root.querySelector("[data-vpm-note]");
        if (note) {
          var parts = [];
          if (settings.warrantyWindowDays > 0) {
            parts.push("Claims within " + settings.warrantyWindowDays + " days of purchase are treated as in-window.");
          }
          parts.push(
            "Approved replacements may include a shipping & handling invoice of " +
              money(settings.shippingHandlingMinor, data.currencyCode) +
              ".",
          );
          note.textContent = parts.join(" ");
        }

        var form = body;
        if (!form) return;

        var name = el("input", { type: "text", name: "customerName", required: "required" });
        var email = el("input", { type: "email", name: "customerEmail", required: "required" });
        var phone = el("input", { type: "tel", name: "customerPhone" });
        var company = el("input", { type: "text", name: "companyName" });
        var sku = el("input", { type: "text", name: "productSku", required: "required" });
        var title = el("input", { type: "text", name: "productTitle" });
        var order = el("input", {
          type: "text",
          name: "orderNumber",
          required: settings.requireOrderNumber ? "required" : null,
        });
        var purchase = el("input", {
          type: "date",
          name: "purchaseDate",
          required: settings.requirePurchaseDate ? "required" : null,
        });
        var issue = el("textarea", {
          name: "issueDescription",
          rows: "5",
          required: "required",
          placeholder: "Describe the failure and how the product was used.",
        });

        var grid = el("div", { className: "vpm-warranty__grid" }, [
          field("Full name", name),
          field("Email", email),
          field("Phone", phone),
          field("Company", company),
          field("Product / SKU", sku),
          field("Product name", title),
          field("Order number", order),
          field("Purchase date", purchase),
          el("div", { className: "vpm-warranty__full" }, [field("Issue description", issue)]),
        ]);

        var submit = el("button", {
          type: "submit",
          className: "vpm-warranty__btn",
          text: root.getAttribute("data-submit-label") || "Submit warranty claim",
        });

        form.appendChild(grid);
        form.appendChild(submit);

        form.addEventListener("submit", function (ev) {
          ev.preventDefault();
          if (errorEl) errorEl.hidden = true;
          submit.disabled = true;
          submit.textContent = "Submitting…";

          var payload = {
            idempotencyKey: uuid(),
            customerName: name.value,
            customerEmail: email.value,
            customerPhone: phone.value,
            companyName: company.value,
            productSku: sku.value,
            productTitle: title.value,
            orderNumber: order.value,
            purchaseDate: purchase.value || null,
            issueDescription: issue.value,
          };

          fetch(proxyBase + "/submit", {
            method: "POST",
            credentials: "same-origin",
            headers: { Accept: "application/json", "Content-Type": "application/json" },
            body: JSON.stringify(payload),
          })
            .then(function (r) {
              return r.json().then(function (j) {
                return { ok: r.ok, status: r.status, body: j };
              });
            })
            .then(function (res) {
              if (!res.ok) throw new Error((res.body && res.body.error) || "Submit failed");
              form.hidden = true;
              if (successEl) {
                successEl.hidden = false;
                successEl.textContent =
                  (res.body.message || settings.successMessage || "Submitted.") +
                  (res.body.claimNumber ? " Claim # " + res.body.claimNumber : "");
              }
            })
            .catch(function (err) {
              showError(err.message || "Submit failed");
              submit.disabled = false;
              submit.textContent = root.getAttribute("data-submit-label") || "Submit warranty claim";
            });
        });
      })
      .catch(function (err) {
        showError(err.message || "Could not load form");
      });
  }

  function refresh() {
    document.querySelectorAll("[data-vpm-warranty]").forEach(mount);
  }

  window.VPMWarranty = { refresh: refresh, mount: mount };
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", refresh);
  } else {
    refresh();
  }
})();
