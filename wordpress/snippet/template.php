<?php
/**
 * ImmobilSesto Gallery Picker — single-file version.
 *
 * GENERATED FILE — do not edit. Built from wordpress/immobilsesto-gallery-picker/
 * by scripts/build-snippet.mjs, so the code here is byte-identical to the tested
 * plugin. Run `npm run build:wp-snippet` to regenerate.
 *
 * Paste this into the Code Snippets plugin (Snippets -> Add New), or append it
 * to your child theme's functions.php. Code Snippets supplies its own opening
 * PHP tag, so delete the first line of this file before pasting there.
 *
 * Deliberately contains no PHP-mode transitions after that first line: Code
 * Snippets strips PHP tags from pasted code, so emitting HTML by dropping out
 * of PHP mode would leave bare markup sitting in a PHP block.
 *
 * It replaces the "Gallery image IDs (comma separated)" text box on listings
 * with a media picker: upload or choose images, thumbnails instead of numbers,
 * multi-select, X to remove, drag to reorder. The field keeps storing the same
 * comma-separated IDs, so nothing else on the site changes.
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

// Guarded so that having both this snippet and the plugin version active is
// harmless rather than a fatal redeclare.
if ( ! class_exists( 'ImmobilSesto_Gallery_Picker' ) ) {

	final class ImmobilSesto_Gallery_Picker {

		const VERSION     = '1.0.0';
		const AJAX_ACTION = 'immobilsesto_gallery_thumbs';
		const NONCE       = 'immobilsesto_gallery_picker';

		/** @var self|null */
		private static $instance = null;

		public static function boot() {
			if ( null === self::$instance ) {
				self::$instance = new self();
			}

			return self::$instance;
		}

		private function __construct() {
			add_action( 'admin_enqueue_scripts', array( $this, 'enqueue' ) );
			add_action( 'admin_print_footer_scripts', array( $this, 'print_assets' ), 20 );
			add_action( 'wp_ajax_' . self::AJAX_ACTION, array( $this, 'ajax_thumbnails' ) );
		}

		/** True only on a post edit screen where the picker makes sense. */
		private function is_edit_screen() {
			global $pagenow;

			if ( 'post.php' !== $pagenow && 'post-new.php' !== $pagenow ) {
				return false;
			}

			if ( ! current_user_can( 'upload_files' ) ) {
				return false;
			}

			$post_types = $this->post_types();
			if ( ! empty( $post_types ) ) {
				$screen = function_exists( 'get_current_screen' ) ? get_current_screen() : null;
				if ( ! $screen || ! in_array( $screen->post_type, $post_types, true ) ) {
					return false;
				}
			}

			return true;
		}

		public function enqueue( $hook ) {
			if ( 'post.php' !== $hook && 'post-new.php' !== $hook ) {
				return;
			}
			if ( ! $this->is_edit_screen() ) {
				return;
			}

			// The picker needs the media modal and drag-to-sort; everything else
			// is printed inline below.
			wp_enqueue_media();
			wp_enqueue_script( 'jquery' );
			wp_enqueue_script( 'jquery-ui-sortable' );
		}

		public function print_assets() {
			if ( ! $this->is_edit_screen() ) {
				return;
			}

			$config = array(
				'ajaxUrl'      => admin_url( 'admin-ajax.php' ),
				'action'       => self::AJAX_ACTION,
				'nonce'        => wp_create_nonce( self::NONCE ),
				'selectors'    => $this->selectors(),
				'labelPattern' => $this->label_pattern(),
				'i18n'         => array(
					'add'         => 'Add or upload images',
					'empty'       => 'No images yet. Click “Add or upload images” to pick them from the media library or upload new ones.',
					'frameTitle'  => 'Select gallery images',
					'frameButton' => 'Add to gallery',
					'remove'      => 'Remove this image',
					'moveLeft'    => 'Move earlier',
					'moveRight'   => 'Move later',
					'clear'       => 'Remove all',
					'confirm'     => 'Remove all images from this gallery?',
					'toggleIds'   => 'Edit IDs manually',
					'hideIds'     => 'Hide ID field',
					'missing'     => 'This image no longer exists in the media library.',
					'loading'     => 'Loading images…',
					'loadFailed'  => 'Could not load the thumbnails. The IDs are still saved — use “Edit IDs manually” if you need to change them.',
					'count'       => '%s images',
					'countOne'    => '1 image',
					'dragHint'    => 'Drag to reorder — the first image is the main one.',
				),
			);
			$out  = '<style id="isgp-inline-style">' . "\n";
			$out .= self::css() . "\n";
			$out .= '</style>' . "\n";
			$out .= '<script id="isgp-inline-config">' . "\n";
			$out .= 'window.ImmobilSestoGalleryPicker = ' . wp_json_encode( $config ) . ';' . "\n";
			$out .= '</script>' . "\n";
			$out .= '<script id="isgp-inline-script">' . "\n";
			$out .= self::js() . "\n";
			$out .= '</script>' . "\n";

			echo $out; // phpcs:ignore WordPress.Security.EscapeOutput
		}

		public function ajax_thumbnails() {
			check_ajax_referer( self::NONCE, 'nonce' );

			if ( ! current_user_can( 'upload_files' ) ) {
				wp_send_json_error( array( 'message' => 'Not allowed.' ), 403 );
			}

			$raw = isset( $_POST['ids'] ) ? sanitize_text_field( wp_unslash( $_POST['ids'] ) ) : '';
			$ids = self::parse_ids( $raw );

			$items   = array();
			$missing = array();

			foreach ( $ids as $id ) {
				$attachment = get_post( $id );
				if ( ! $attachment || 'attachment' !== $attachment->post_type ) {
					$missing[] = $id;
					continue;
				}

				$items[] = array(
					'id'      => $id,
					'thumb'   => wp_get_attachment_image_url( $id, 'thumbnail' ),
					'full'    => wp_get_attachment_image_url( $id, 'full' ),
					'title'   => get_the_title( $id ),
					'alt'     => get_post_meta( $id, '_wp_attachment_image_alt', true ),
					'isImage' => wp_attachment_is_image( $id ),
				);
			}

			wp_send_json_success(
				array(
					'items'   => $items,
					'missing' => $missing,
				)
			);
		}

		/**
		 * @param string $raw
		 * @return int[]
		 */
		public static function parse_ids( $raw ) {
			$parts = preg_split( '/[^0-9]+/', (string) $raw, -1, PREG_SPLIT_NO_EMPTY );
			if ( ! is_array( $parts ) ) {
				return array();
			}

			$ids = array();
			foreach ( $parts as $part ) {
				$id = (int) $part;
				if ( $id > 0 && ! in_array( $id, $ids, true ) ) {
					$ids[] = $id;
				}
			}

			return $ids;
		}

		private function post_types() {
			$types = apply_filters( 'immobilsesto_gallery_picker_post_types', array() );

			return is_array( $types ) ? array_values( array_filter( array_map( 'strval', $types ) ) ) : array();
		}

		private function selectors() {
			$selectors = apply_filters(
				'immobilsesto_gallery_picker_selectors',
				array( '[data-gallery-picker]' )
			);

			return is_array( $selectors ) ? array_values( array_filter( array_map( 'strval', $selectors ) ) ) : array();
		}

		private function label_pattern() {
			$pattern = apply_filters(
				'immobilsesto_gallery_picker_label_pattern',
				'galler(y|ia)\\s*(image|immagin\\w*)?\\s*(id|ids)?'
			);

			return is_string( $pattern ) && '' !== $pattern ? $pattern : 'gallery';
		}

		private static function css() {
			return <<<'ISGP_CSS'
__GALLERY_PICKER_CSS__
ISGP_CSS;
		}

		private static function js() {
			return <<<'ISGP_JS'
__GALLERY_PICKER_JS__
ISGP_JS;
		}
	}

	ImmobilSesto_Gallery_Picker::boot();
}
