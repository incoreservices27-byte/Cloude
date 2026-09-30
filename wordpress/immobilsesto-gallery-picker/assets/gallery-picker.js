/**
 * Progressive enhancement for the "Gallery image IDs (comma separated)" field.
 *
 * The field itself belongs to another plugin, so this never replaces it: the
 * original input stays in the DOM and keeps holding the comma-separated IDs.
 * Everything here drives that value from a thumbnail grid, which is why the
 * existing save handler and theme template keep working untouched.
 */
(function ($) {
	'use strict';

	var cfg = window.ImmobilSestoGalleryPicker || {};
	var i18n = cfg.i18n || {};
	var BOUND = 'isgpBound';

	function t(key, fallback) {
		return typeof i18n[key] === 'string' ? i18n[key] : fallback;
	}

	// -----------------------------------------------------------------------
	// ID parsing — mirrors the PHP side so both ends agree on what is an ID
	// -----------------------------------------------------------------------

	function parseIds(value) {
		var seen = {};
		var out = [];

		String(value == null ? '' : value)
			.split(/[^0-9]+/)
			.forEach(function (chunk) {
				if (!chunk) {
					return;
				}
				var id = parseInt(chunk, 10);
				if (id > 0 && !seen[id]) {
					seen[id] = true;
					out.push(id);
				}
			});

		return out;
	}

	// -----------------------------------------------------------------------
	// Finding the field
	// -----------------------------------------------------------------------

	/**
	 * Collects the text that labels a field. Meta boxes are hand-rolled HTML far
	 * more often than not, so a `for=` attribute cannot be relied on — the label
	 * is just as likely to be a sibling <label>, a <th>, or a bare <strong>.
	 */
	function labelTextFor(input) {
		var parts = [];

		if (input.id) {
			var explicit = document.querySelector('label[for="' + cssEscape(input.id) + '"]');
			if (explicit) {
				parts.push(explicit.textContent);
			}
		}

		var wrapping = input.closest('label');
		if (wrapping) {
			parts.push(wrapping.textContent);
		}

		var row = input.closest('tr');
		if (row) {
			var th = row.querySelector('th');
			if (th) {
				parts.push(th.textContent);
			}
		}

		// The screenshot's layout: a label (or <strong>/<p>) immediately above
		// the input, inside a shared wrapper.
		var previous = input.previousElementSibling;
		var hops = 0;
		while (previous && hops < 3) {
			parts.push(previous.textContent);
			previous = previous.previousElementSibling;
			hops++;
		}

		var parent = input.parentElement;
		if (parent) {
			var nested = parent.querySelector('label, strong, b');
			if (nested && !nested.contains(input)) {
				parts.push(nested.textContent);
			}
		}

		return parts.join(' ').replace(/\s+/g, ' ').trim();
	}

	function cssEscape(value) {
		if (window.CSS && typeof window.CSS.escape === 'function') {
			return window.CSS.escape(value);
		}
		return String(value).replace(/["\\]/g, '\\$&');
	}

	function labelMatcher() {
		var body = typeof cfg.labelPattern === 'string' && cfg.labelPattern ? cfg.labelPattern : 'gallery';
		try {
			return new RegExp(body, 'i');
		} catch (e) {
			return /gallery/i;
		}
	}

	/** Name/id heuristic: something gallery-ish that stores ids or images. */
	function attributesLookRight(input) {
		var haystack = ((input.name || '') + ' ' + (input.id || '')).toLowerCase();
		return /galler|gallerie/.test(haystack) && /id|image|img|immagin/.test(haystack);
	}

	function candidateFields() {
		var nodes = [];

		function push(node, force) {
			if (!node || nodes.indexOf(node) !== -1) {
				return;
			}
			if (node.dataset && node.dataset[BOUND]) {
				return;
			}
			var tag = node.tagName;
			if (tag !== 'INPUT' && tag !== 'TEXTAREA') {
				return;
			}
			if (tag === 'INPUT') {
				var type = (node.getAttribute('type') || 'text').toLowerCase();
				if (type !== 'text' && type !== 'hidden' && type !== 'search') {
					return;
				}
			}
			// An ID list is digits and separators. Anything else — prose, a URL,
			// a slug — means the heuristics matched the wrong field. An explicit
			// selector is a deliberate choice, so it skips this check.
			if (!force && !/^[\s\d,;]*$/.test(node.value || '')) {
				return;
			}
			nodes.push(node);
		}

		(cfg.selectors || []).forEach(function (selector) {
			try {
				document.querySelectorAll(selector).forEach(function (node) {
					push(node, true);
				});
			} catch (e) {
				/* A bad selector from a filter must not take the whole script down. */
			}
		});

		var pattern = labelMatcher();
		document.querySelectorAll('input, textarea').forEach(function (node) {
			if (node.dataset && node.dataset[BOUND]) {
				return;
			}
			if (attributesLookRight(node) || pattern.test(labelTextFor(node))) {
				push(node);
			}
		});

		return nodes;
	}

	// -----------------------------------------------------------------------
	// The widget
	// -----------------------------------------------------------------------

	function enhance(input) {
		input.dataset[BOUND] = '1';

		var state = {
			input: input,
			items: [],
			frame: null,
			showIds: false,
			syncing: false
		};

		var wrap = document.createElement('div');
		wrap.className = 'isgp-wrap';

		var grid = document.createElement('ul');
		grid.className = 'isgp-grid';

		var emptyNote = document.createElement('p');
		emptyNote.className = 'isgp-empty';
		emptyNote.textContent = t('loading', 'Loading images…');

		var actions = document.createElement('p');
		actions.className = 'isgp-actions';

		var addButton = button('button button-secondary isgp-add', t('add', 'Add or upload images'));
		var clearButton = button('button-link isgp-clear', t('clear', 'Remove all'));
		var toggleButton = button('button-link isgp-toggle', t('toggleIds', 'Edit IDs manually'));

		actions.appendChild(addButton);
		actions.appendChild(document.createTextNode(' '));
		actions.appendChild(clearButton);
		actions.appendChild(document.createTextNode(' '));
		actions.appendChild(toggleButton);

		var status = document.createElement('p');
		status.className = 'isgp-status';

		wrap.appendChild(grid);
		wrap.appendChild(emptyNote);
		wrap.appendChild(actions);
		wrap.appendChild(status);

		// Insert the widget where the field is, then tuck the field away. It stays
		// a real form control so the value still posts with the rest of the form.
		input.parentNode.insertBefore(wrap, input.nextSibling);
		input.classList.add('isgp-source');

		state.render = function () {
			grid.textContent = '';

			state.items.forEach(function (item, index) {
				grid.appendChild(tile(state, item, index));
			});

			var count = state.items.length;
			emptyNote.textContent = t('empty', 'No images yet.');
			emptyNote.style.display = count ? 'none' : '';
			clearButton.style.display = count ? '' : 'none';

			status.classList.remove('isgp-status-error');
			if (count === 0) {
				status.textContent = '';
			} else if (count === 1) {
				status.textContent = t('countOne', '1 image');
			} else {
				status.textContent = t('count', '%s images').replace('%s', String(count)) +
					' — ' + t('dragHint', 'Drag to reorder.');
			}
		};

		state.warn = function (message) {
			status.textContent = message;
			status.classList.add('isgp-status-error');
		};

		state.sync = function () {
			var value = state.items
				.map(function (item) {
					return item.id;
				})
				.join(',');

			if (input.value !== value) {
				input.value = value;
				state.syncing = true;
				// Both events, because the classic editor's unsaved-changes guard
				// listens through jQuery while newer code listens natively.
				input.dispatchEvent(new Event('input', { bubbles: true }));
				input.dispatchEvent(new Event('change', { bubbles: true }));
				$(input).trigger('change');
				state.syncing = false;
			}
		};

		state.add = function (attachment) {
			var id = parseInt(attachment.id, 10);
			if (!(id > 0) || state.has(id)) {
				return;
			}
			state.items.push({
				id: id,
				thumb: thumbUrlFrom(attachment),
				title: attachment.title || '',
				alt: attachment.alt || '',
				missing: false
			});
		};

		state.has = function (id) {
			return state.items.some(function (item) {
				return item.id === id;
			});
		};

		state.move = function (from, to) {
			if (to < 0 || to >= state.items.length) {
				return;
			}
			var moved = state.items.splice(from, 1)[0];
			state.items.splice(to, 0, moved);
			state.render();
			state.sync();
			focusTile(grid, to, to > from ? 'right' : 'left');
		};

		state.remove = function (index) {
			state.items.splice(index, 1);
			state.render();
			state.sync();
		};

		addButton.addEventListener('click', function () {
			openFrame(state);
		});

		clearButton.addEventListener('click', function () {
			if (state.items.length && window.confirm(t('confirm', 'Remove all images?'))) {
				state.items = [];
				state.render();
				state.sync();
			}
		});

		toggleButton.addEventListener('click', function () {
			state.showIds = !state.showIds;
			input.classList.toggle('isgp-source-visible', state.showIds);
			toggleButton.textContent = state.showIds
				? t('hideIds', 'Hide ID field')
				: t('toggleIds', 'Edit IDs manually');
			if (state.showIds) {
				input.focus();
			}
		});

		// Typing in the revealed ID field should still drive the grid.
		input.addEventListener('change', function () {
			if (state.showIds && !state.syncing) {
				loadThumbnails(state, parseIds(input.value));
			}
		});

		if ($.fn.sortable) {
			$(grid).sortable({
				items: '> li.isgp-item',
				placeholder: 'isgp-item isgp-placeholder',
				forcePlaceholderSize: true,
				tolerance: 'pointer',
				update: function () {
					var order = [];
					$(grid)
						.find('> li.isgp-item')
						.each(function () {
							var id = parseInt(this.getAttribute('data-id'), 10);
							var item = state.items.filter(function (candidate) {
								return candidate.id === id;
							})[0];
							if (item) {
								order.push(item);
							}
						});
					if (order.length === state.items.length) {
						state.items = order;
						state.render();
						state.sync();
					}
				}
			});
		}

		loadThumbnails(state, parseIds(input.value));
	}

	function button(className, label) {
		var el = document.createElement('button');
		el.type = 'button';
		el.className = className;
		el.textContent = label;
		return el;
	}

	function tile(state, item, index) {
		var li = document.createElement('li');
		li.className = 'isgp-item' + (item.missing ? ' isgp-item-missing' : '');
		li.setAttribute('data-id', String(item.id));

		if (item.missing) {
			var warn = document.createElement('span');
			warn.className = 'isgp-missing-mark';
			warn.textContent = '!';
			warn.title = t('missing', 'This image no longer exists.');
			li.appendChild(warn);
		} else if (item.thumb) {
			var img = document.createElement('img');
			img.src = item.thumb;
			img.alt = item.alt || item.title || '';
			img.loading = 'lazy';
			li.appendChild(img);
		} else {
			var blank = document.createElement('span');
			blank.className = 'isgp-missing-mark';
			blank.textContent = '?';
			li.appendChild(blank);
		}

		var badge = document.createElement('span');
		badge.className = 'isgp-badge';
		badge.textContent = '#' + item.id;
		li.appendChild(badge);

		var controls = document.createElement('span');
		controls.className = 'isgp-controls';

		// Arrow buttons exist so reordering is not drag-only — dragging is
		// unusable by keyboard and awkward on a touchscreen.
		var left = button('isgp-ctl isgp-left', '\u2039');
		left.setAttribute('aria-label', t('moveLeft', 'Move earlier'));
		left.disabled = index === 0;
		left.addEventListener('click', function () {
			state.move(index, index - 1);
		});

		var right = button('isgp-ctl isgp-right', '\u203A');
		right.setAttribute('aria-label', t('moveRight', 'Move later'));
		right.disabled = index === state.items.length - 1;
		right.addEventListener('click', function () {
			state.move(index, index + 1);
		});

		var remove = button('isgp-ctl isgp-remove', '\u00D7');
		remove.setAttribute('aria-label', t('remove', 'Remove this image') + ' (#' + item.id + ')');
		remove.addEventListener('click', function () {
			state.remove(index);
		});

		controls.appendChild(left);
		controls.appendChild(right);
		controls.appendChild(remove);
		li.appendChild(controls);

		if (index === 0) {
			var main = document.createElement('span');
			main.className = 'isgp-main';
			main.textContent = '1';
			li.appendChild(main);
		}

		return li;
	}

	function focusTile(grid, index, direction) {
		var tiles = grid.querySelectorAll('li.isgp-item');
		var target = tiles[index];
		if (!target) {
			return;
		}
		// Prefer the arrow that was just used; fall back to the other one when it
		// has become disabled at the end of the row.
		var preferred = target.querySelector('.isgp-' + direction + ':not([disabled])');
		var control = preferred || target.querySelector('.isgp-ctl:not([disabled])');
		if (control) {
			control.focus();
		}
	}

	function thumbUrlFrom(attachment) {
		if (attachment.sizes && attachment.sizes.thumbnail && attachment.sizes.thumbnail.url) {
			return attachment.sizes.thumbnail.url;
		}
		if (attachment.sizes && attachment.sizes.medium && attachment.sizes.medium.url) {
			return attachment.sizes.medium.url;
		}
		return attachment.url || attachment.icon || '';
	}

	// -----------------------------------------------------------------------
	// Media modal
	// -----------------------------------------------------------------------

	function openFrame(state) {
		if (!window.wp || !window.wp.media) {
			return;
		}

		if (!state.frame) {
			state.frame = window.wp.media({
				title: t('frameTitle', 'Select gallery images'),
				button: { text: t('frameButton', 'Add to gallery') },
				library: { type: 'image' },
				multiple: true
			});

			// The modal's "Upload files" tab is what makes this an upload flow and
			// not just a picker, so nothing here restricts it to the library.
			state.frame.on('select', function () {
				state.frame
					.state()
					.get('selection')
					.each(function (model) {
						state.add(model.toJSON());
					});
				state.render();
				state.sync();
			});

			// A reused frame keeps its previous selection, which would re-add the
			// same images on every open.
			state.frame.on('open', function () {
				state.frame.state().get('selection').reset();
			});
		}

		state.frame.open();
	}

	// -----------------------------------------------------------------------
	// Thumbnail loading
	// -----------------------------------------------------------------------

	function loadThumbnails(state, ids) {
		if (!ids.length) {
			state.items = [];
			state.render();
			return;
		}

		$.post(cfg.ajaxUrl, {
			action: cfg.action,
			nonce: cfg.nonce,
			ids: ids.join(',')
		})
			.done(function (response) {
				if (!response || !response.success || !response.data) {
					fallbackItems(state, ids);
					return;
				}

				var byId = {};
				(response.data.items || []).forEach(function (item) {
					byId[item.id] = item;
				});

				// Rebuild in the order the field gave us, not the order the server
				// happened to return, and keep IDs whose attachment is gone so the
				// editor can see and fix them instead of losing them on save.
				state.items = ids.map(function (id) {
					var found = byId[id];
					if (!found) {
						return { id: id, thumb: '', title: '', alt: '', missing: true };
					}
					return {
						id: id,
						thumb: found.thumb || '',
						title: found.title || '',
						alt: found.alt || '',
						missing: false
					};
				});

				state.render();
			})
			.fail(function () {
				fallbackItems(state, ids);
			});
	}

	/** Network or nonce failure: show the IDs rather than an empty grid. */
	function fallbackItems(state, ids) {
		state.items = ids.map(function (id) {
			return { id: id, thumb: '', title: '', alt: '', missing: false };
		});
		state.render();
		state.warn(t('loadFailed', 'Could not load the thumbnails.'));
	}

	// -----------------------------------------------------------------------
	// Boot
	// -----------------------------------------------------------------------

	function scan() {
		candidateFields().forEach(enhance);
	}

	$(function () {
		scan();

		// Meta boxes render late under the block editor, and any box can be moved
		// or lazily opened, so keep watching instead of scanning once.
		if (window.MutationObserver) {
			var pending = null;
			new MutationObserver(function () {
				window.clearTimeout(pending);
				pending = window.setTimeout(scan, 200);
			}).observe(document.body, { childList: true, subtree: true });
		}
	});
})(jQuery);
