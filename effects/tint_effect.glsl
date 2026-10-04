uniform float red;
uniform float green;
uniform float blue;
uniform float blend;

vec4 d2da_effect(vec4 c) {
    vec3 pix_color = c.rgb;
    vec3 color = vec3(red * c.a, green * c.a, blue * c.a);
    return vec4(mix(pix_color, color, blend), c.a * 0.85);
}
