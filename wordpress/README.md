# ImmobilSesto Gallery Picker

A small WordPress plugin that replaces the **Gallery image IDs (comma separated)** text box on
listings with a real media picker: upload or choose images, see them as thumbnails, drag to
reorder, remove individually.

## The one thing worth knowing

It does not replace the field. The original input stays in the form, hidden, still holding
`18,19,20,21` — the picker just drives its value.

That means **nothing else has to change**: the meta box that renders the field, the code that
saves it, and the theme template that reads it all keep working exactly as they do today.
Deactivate the plugin and the plain text box comes back with its data intact.

## Install

1. Download `immobilsesto-gallery-picker.zip`.
2. In wp-admin: **Plugins → Add New → Upload Plugin**, choose the zip, **Install Now**,
   then **Activate**.
3. Open any listing. The gallery field is now a thumbnail grid.

To install by hand instead, copy the `immobilsesto-gallery-picker/` folder into
`wp-content/plugins/` and activate it.

## What you get

| | |
| --- | --- |
| **Add or upload images** | Opens the standard WordPress media modal. Its **Upload files** tab takes new images straight from your computer; **Media Library** picks existing ones. Multi-select works. |
| **Drag to reorder** | The first image is badged `1` — that is the main one. |
| **Arrow buttons** | `‹` and `›` on each tile, so reordering also works by keyboard and on a phone, where dragging does not. |
| **Remove** | `×` on each tile, or **Remove all**. |
| **Deleted images** | An ID whose attachment no longer exists shows as a red dashed tile rather than vanishing — the ID is kept so you can see and fix it instead of losing it silently on the next save. |
| **Edit IDs manually** | Reveals the original text field. Type or paste IDs and the grid re-reads them. Commas, spaces, semicolons and newlines all parse. |

## If it does not find the field

The plugin looks for the field three ways, in order: a `data-gallery-picker` attribute, a
`name`/`id` containing something gallery-ish plus `id`/`image`, and a label matching the
gallery pattern. A field holding anything other than digits and separators is skipped, so a
description box is never mistaken for the ID list.

If your field is named unusually, point the plugin at it directly from a site plugin or
`functions.php`:

```php
add_filter( 'immobilsesto_gallery_picker_selectors', function ( $selectors ) {
	$selectors[] = '#the_exact_field_id';
	return $selectors;
} );
```

Two other filters are available:

```php
// Only run on the listing post type, instead of every edit screen.
add_filter( 'immobilsesto_gallery_picker_post_types', function () {
	return array( 'property' );
} );

// Change the label text it matches (a regex body, matched case-insensitively).
add_filter( 'immobilsesto_gallery_picker_label_pattern', function () {
	return 'foto|galleria';
} );
```

## Notes

- Requires WordPress 5.8+ and PHP 7.4+.
- Only loads on post edit screens, and only for users who can upload files — everyone else
  keeps the plain field.
- Thumbnails for already-saved IDs are fetched in a single AJAX request, nonce-checked and
  capability-checked, rather than one request per image.
- If that request fails, the IDs still render as tiles and a warning is shown. Nothing is
  discarded.

## Development

```bash
npm test                 # includes test/wp-gallery-picker.test.js
npm run build:wp-plugin  # produces dist-wp/immobilsesto-gallery-picker.zip
```

The test suite drives the picker in a JSDOM copy of the real listing form — field detection,
rendering, reordering, removal, the media modal and the failure path are all exercised. Only
the AJAX call and the media modal itself are faked.
