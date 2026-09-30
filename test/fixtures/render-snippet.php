<?php
/**
 * Renders the generated snippet's admin output with just enough of WordPress
 * stubbed to run it, so the build can be checked without a WordPress install.
 * Prints the HTML the snippet would emit on a post edit screen.
 */

define( 'ABSPATH', __DIR__ );

$GLOBALS['pagenow'] = 'post.php';

function add_action() {}
function apply_filters( $hook, $value ) { return $value; }
function current_user_can( $cap ) { return true; }
function get_current_screen() { return (object) array( 'post_type' => 'property' ); }
function admin_url( $path = '' ) { return 'https://example.test/wp-admin/' . $path; }
function wp_create_nonce( $action ) { return 'stub-nonce'; }
function wp_json_encode( $data ) { return json_encode( $data ); }
function wp_enqueue_media() {}
function wp_enqueue_script( $handle ) {}

$snippet = $argv[1];
require $snippet;

ImmobilSesto_Gallery_Picker::boot()->print_assets();
