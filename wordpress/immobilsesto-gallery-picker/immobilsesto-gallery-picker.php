<?php
/**
 * Plugin Name:       ImmobilSesto Gallery Picker
 * Description:       Replaces the "Gallery image IDs (comma separated)" text box on listings with a real media picker — upload or choose images, see thumbnails, drag to reorder, remove. The field still stores the same comma-separated IDs, so saving and front-end output are unchanged.
 * Version:           1.0.0
 * Requires at least: 5.8
 * Requires PHP:      7.4
 * License:           GPL-2.0-or-later
 * License URI:       https://www.gnu.org/licenses/gpl-2.0.html
 * Text Domain:       immobilsesto-gallery-picker
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

/**
 * The field this enhances is rendered by another plugin, so this one never
 * touches the meta box or the save path. It finds the existing input in the
 * browser, hides it, and drives its value from a thumbnail grid — which means
 * the stored format stays exactly what the theme already reads.
 */
final class ImmobilSesto_Gallery_Picker {

	const VERSION     = '1.0.0';
	const HANDLE      = 'immobilsesto-gallery-picker';
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
		add_action( 'wp_ajax_' . self::AJAX_ACTION, array( $this, 'ajax_thumbnails' ) );
	}

	// -----------------------------------------------------------------------
	// Admin assets
	// -----------------------------------------------------------------------

	/**
	 * @param string $hook Current admin page.
	 */
	public function enqueue( $hook ) {
		if ( 'post.php' !== $hook && 'post-new.php' !== $hook ) {
			return;
		}

		// Without this capability the media modal would open onto an empty
		// library, so leave the plain text field in place instead.
		if ( ! current_user_can( 'upload_files' ) ) {
			return;
		}

		$post_types = $this->post_types();
		if ( ! empty( $post_types ) ) {
			$screen = function_exists( 'get_current_screen' ) ? get_current_screen() : null;
			if ( ! $screen || ! in_array( $screen->post_type, $post_types, true ) ) {
				return;
			}
		}

		wp_enqueue_media();

		$base = plugin_dir_url( __FILE__ ) . 'assets/';

		wp_enqueue_style( self::HANDLE, $base . 'gallery-picker.css', array(), self::VERSION );
		wp_enqueue_script(
			self::HANDLE,
			$base . 'gallery-picker.js',
			array( 'jquery', 'jquery-ui-sortable' ),
			self::VERSION,
			true
		);

		wp_localize_script(
			self::HANDLE,
			'ImmobilSestoGalleryPicker',
			array(
				'ajaxUrl'      => admin_url( 'admin-ajax.php' ),
				'action'       => self::AJAX_ACTION,
				'nonce'        => wp_create_nonce( self::NONCE ),
				'selectors'    => $this->selectors(),
				'labelPattern' => $this->label_pattern(),
				'i18n'         => array(
					'add'         => __( 'Add or upload images', 'immobilsesto-gallery-picker' ),
					'empty'       => __( 'No images yet. Click “Add or upload images” to pick them from the media library or upload new ones.', 'immobilsesto-gallery-picker' ),
					'frameTitle'  => __( 'Select gallery images', 'immobilsesto-gallery-picker' ),
					'frameButton' => __( 'Add to gallery', 'immobilsesto-gallery-picker' ),
					'remove'      => __( 'Remove this image', 'immobilsesto-gallery-picker' ),
					'moveLeft'    => __( 'Move earlier', 'immobilsesto-gallery-picker' ),
					'moveRight'   => __( 'Move later', 'immobilsesto-gallery-picker' ),
					'clear'       => __( 'Remove all', 'immobilsesto-gallery-picker' ),
					'confirm'     => __( 'Remove all images from this gallery?', 'immobilsesto-gallery-picker' ),
					'toggleIds'   => __( 'Edit IDs manually', 'immobilsesto-gallery-picker' ),
					'hideIds'     => __( 'Hide ID field', 'immobilsesto-gallery-picker' ),
					'missing'     => __( 'This image no longer exists in the media library.', 'immobilsesto-gallery-picker' ),
					'loading'     => __( 'Loading images…', 'immobilsesto-gallery-picker' ),
					'loadFailed'  => __( 'Could not load the thumbnails. The IDs are still saved — use “Edit IDs manually” if you need to change them.', 'immobilsesto-gallery-picker' ),
					/* translators: %s: number of images. */
					'count'       => __( '%s images', 'immobilsesto-gallery-picker' ),
					'countOne'    => __( '1 image', 'immobilsesto-gallery-picker' ),
					'dragHint'    => __( 'Drag to reorder — the first image is the main one.', 'immobilsesto-gallery-picker' ),
				),
			)
		);
	}

	// -----------------------------------------------------------------------
	// AJAX
	// -----------------------------------------------------------------------

	/**
	 * Resolves a list of attachment IDs to thumbnails in one round trip, rather
	 * than letting the browser fetch each attachment separately.
	 */
	public function ajax_thumbnails() {
		check_ajax_referer( self::NONCE, 'nonce' );

		if ( ! current_user_can( 'upload_files' ) ) {
			wp_send_json_error( array( 'message' => __( 'Not allowed.', 'immobilsesto-gallery-picker' ) ), 403 );
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

	// -----------------------------------------------------------------------
	// Helpers
	// -----------------------------------------------------------------------

	/**
	 * Splits any separator a human might have typed — commas, spaces, newlines,
	 * semicolons — into a de-duplicated list of positive IDs.
	 *
	 * @param string $raw Raw field value.
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

	/**
	 * Post types to enhance. Empty means every post type, which is the safe
	 * default when we do not know what the listing CPT is called.
	 *
	 * @return string[]
	 */
	private function post_types() {
		$types = apply_filters( 'immobilsesto_gallery_picker_post_types', array() );

		return is_array( $types ) ? array_values( array_filter( array_map( 'strval', $types ) ) ) : array();
	}

	/**
	 * Extra CSS selectors that identify the gallery field, for sites where the
	 * name/label heuristics do not fire.
	 *
	 * @return string[]
	 */
	private function selectors() {
		$selectors = apply_filters(
			'immobilsesto_gallery_picker_selectors',
			array( '[data-gallery-picker]' )
		);

		return is_array( $selectors ) ? array_values( array_filter( array_map( 'strval', $selectors ) ) ) : array();
	}

	/**
	 * Regular expression body (no delimiters, matched case-insensitively in JS)
	 * tested against each field's label text.
	 *
	 * @return string
	 */
	private function label_pattern() {
		$pattern = apply_filters(
			'immobilsesto_gallery_picker_label_pattern',
			'galler(y|ia)\\s*(image|immagin\\w*)?\\s*(id|ids)?'
		);

		return is_string( $pattern ) && '' !== $pattern ? $pattern : 'gallery';
	}
}

ImmobilSesto_Gallery_Picker::boot();
